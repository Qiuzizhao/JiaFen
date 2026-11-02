"""JF-004: explainable, read-only per-lesson statistics. No stored average."""
import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP

BJ = timezone(timedelta(hours=8))
VERSION = "JF004-v1"


def average(net, count):
    if not count:
        return None
    return float((Decimal(net) / Decimal(count)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def period_bounds(period, month, now):
    if period not in ("month", "history"):
        raise ValueError("统计周期须为 month 或 history")
    cutoff = now.astimezone(BJ).strftime("%Y-%m-%d %H:%M:%S.%f")
    if period == "history":
        if month is not None:
            raise ValueError("历史统计不接受月份参数")
        return None, cutoff, None
    month = month if month is not None else now.astimezone(BJ).strftime("%Y-%m")
    if not re.fullmatch(r"[0-9]{4}-(0[1-9]|1[0-2])", month):
        raise ValueError("月份格式须为 YYYY-MM")
    year, number = map(int, month.split("-"))
    if not 1900 <= year <= 9998:
        raise ValueError("月份超出范围")
    start = month + "-01 00:00:00"
    end = f"{year + (number == 12):04d}-{number % 12 + 1:02d}-01 00:00:00"
    return start, min(end, cutoff), month


def calculate_class(db, uid, cls, period, month, now):
    start, end, month = period_bounds(period, month, now)
    lower = start or "0001-01-01 00:00:00"
    cid = cls["id"]
    roster = [dict(r) for r in db.execute(
        "SELECT id,name,sort_order FROM groups WHERE class_id=? ORDER BY sort_order,id", (cid,))]
    rows = [dict(r) for r in db.execute(
        "SELECT m.*,le.lesson_id,l.start_at AS lesson_start,l.end_at AS lesson_end,"
        "l.status AS lesson_status,l.source AS lesson_source,l.archived_at AS lesson_archived "
        "FROM monthly_score_entries m LEFT JOIN lesson_entries le ON le.entry_id=m.id "
        "LEFT JOIN lessons l ON l.id=le.lesson_id AND l.owner_id=m.owner_id AND l.class_id=m.class_id "
        "WHERE m.owner_id=? AND m.class_id=? AND m.occurred_at>=? AND m.occurred_at<? "
        "ORDER BY m.occurred_at,m.id", (uid, cid, lower, end))]
    lessons = [dict(r) for r in db.execute(
        "SELECT l.*,(SELECT COUNT(*) FROM lesson_entries le JOIN monthly_score_entries m ON m.id=le.entry_id "
        "WHERE le.lesson_id=l.id AND m.owner_id=l.owner_id AND m.class_id=l.class_id AND m.voided_at IS NULL) AS valid_count "
        "FROM lessons l WHERE l.owner_id=? AND l.class_id=? AND l.archived_at IS NULL "
        "AND l.start_at>=? AND l.start_at<? ORDER BY l.start_at,l.id", (uid, cid, lower, end))]
    # Match JF-003: an automatic window with all entries undone is not proof a class occurred.
    discarded = [l for l in lessons if l["source"] == "automatic" and not l["valid_count"]]
    lessons = [l for l in lessons if l not in discarded]
    recognized = [l for l in lessons if l["status"] == "recognized"]
    pending = [l for l in lessons if l["status"] != "recognized"]
    ids = {l["id"] for l in recognized}
    count = len(recognized)
    names = {g["id"]: g["name"] for g in roster}
    group_ids = [g["id"] for g in roster]
    for e in rows:
        if e["group_id"] not in names:
            names[e["group_id"]] = f"已移除小组#{e['group_id']}"
            group_ids.append(e["group_id"])
    contributions = {l["id"]: {gid: [] for gid in group_ids} for l in recognized}
    exclusions = []
    effective = [e for e in rows if e["voided_at"] is None]
    for e in effective:
        lid = e["lesson_id"]
        if not lid:
            reason = "unassigned"
        elif not e["lesson_start"] or e["lesson_archived"] or not e["lesson_start"] <= e["occurred_at"] < e["lesson_end"]:
            reason = "invalid_assignment"
        elif e["lesson_status"] != "recognized":
            reason = "unconfirmed_lesson"
        elif lid not in ids:
            reason = "lesson_outside_period"
        else:
            contributions[lid][e["group_id"]].append(e)
            continue
        exclusions.append({"entry_id": e["id"], "transaction_id": e["transaction_id"], "group_id": e["group_id"],
                           "delta": e["delta"], "occurred_at": e["occurred_at"], "reason": reason,
                           "lesson_id": lid if e["lesson_start"] else None})
    overlap_rows = [dict(r) for r in db.execute(
        "SELECT id,start_at,end_at FROM lessons WHERE owner_id=? AND class_id=? AND archived_at IS NULL "
        "AND start_at<? AND end_at>? ORDER BY start_at,id", (uid, cid, end, lower))]
    overlaps = []
    for i, a in enumerate(overlap_rows):
        for b in overlap_rows[i+1:]:
            if b["start_at"] >= a["end_at"]:
                break
            overlaps.append([a["id"], b["id"]])
    warnings = []
    if pending:
        warnings.append("unconfirmed_lessons")
    if exclusions:
        warnings.append("excluded_effective_entries")
    if overlaps:
        warnings.append("overlapping_lessons")
    if not count:
        warnings.append("no_recognized_lessons")
    if start and start >= end:
        warnings.append("period_not_started")
    blocked = bool(warnings)
    group_results = []
    explained_lessons = []
    for l in recognized:
        entries = [e for es in contributions[l["id"]].values() for e in es]
        explained_lessons.append({"id": l["id"], "start_at": l["start_at"], "end_at": l["end_at"],
                                 "revision": l["revision"], "source": l["source"],
                                 "net_score": sum(e["delta"] for e in entries),
                                 "entry_ids": [e["id"] for e in entries], "effective_entry_count": len(entries)})
    for gid in group_ids:
        period_net = sum(e["delta"] for e in effective if e["group_id"] == gid)
        lesson_net = sum(e["delta"] for es in contributions.values() for e in es[gid])
        per_lesson = []
        for l in recognized:
            entries = contributions[l["id"]][gid]
            per_lesson.append({"lesson_id": l["id"], "start_at": l["start_at"], "end_at": l["end_at"],
                               "net_score": sum(e["delta"] for e in entries),
                               "entries": [{"entry_id": e["id"], "transaction_id": e["transaction_id"],
                                            "delta": e["delta"], "occurred_at": e["occurred_at"], "reason": e["reason"]}
                                           for e in entries]})
        group_results.append({"group_id": gid, "name": names[gid], "removed": gid not in {g["id"] for g in roster},
                              "period_net_score": period_net, "recognized_net_score": lesson_net,
                              "unresolved_net_score": period_net - lesson_net, "lesson_count": count,
                              "average": None if blocked else average(period_net, count),
                              "partial_average": average(lesson_net, count),
                              "exact_ratio": {"numerator": period_net, "denominator": count},
                              "partial_ratio": {"numerator": lesson_net, "denominator": count},
                              "lessons": per_lesson})
    period_net = sum(g["period_net_score"] for g in group_results)
    lesson_net = sum(g["recognized_net_score"] for g in group_results)
    digest = hashlib.sha256(json.dumps({"owner_id": uid, "class_id": cid, "class_name": cls["name"], "period": period, "month": month, "roster": roster,
                                        "entries": rows, "lessons": lessons, "ignored": discarded, "overlaps": overlaps},
                                       ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    return {
        "class_id": cid, "name": cls["name"], "period": period, "month": month,
        "period_net_score": period_net, "recognized_net_score": lesson_net,
        "unresolved_net_score": period_net - lesson_net, "lesson_count": count,
        "average": None if blocked else average(period_net, count),
        "partial_average": average(lesson_net, count),
        "exact_ratio": {"numerator": period_net, "denominator": count},
        "partial_ratio": {"numerator": lesson_net, "denominator": count},
        "groups": group_results, "lessons": explained_lessons, "exclusions": exclusions,
        "quality": {
            "status": "partial" if blocked and count else "unknown" if blocked else "recorded_only",
            "can_compute": not blocked,
            "warnings": warnings,
            "pending_lessons": [{"id": l["id"], "status": l["status"], "start_at": l["start_at"], "end_at": l["end_at"]}
                                for l in pending],
            "overlapping_lesson_ids": overlaps, "voided_entries": len(rows)-len(effective),
            "ignored_automatic_windows": [l["id"] for l in discarded],
            "historical_completeness": "not_attested",
            "note": "分母为已识别课堂记录数；没有记分的课堂须补建，当前数据不能证明未登记课堂不存在。",
            "earliest_available_entry": db.execute(
                "SELECT MIN(occurred_at) FROM monthly_score_entries WHERE owner_id=? AND class_id=?", (uid,cid)).fetchone()[0],
        },
        "data_revision": digest,
    }


def register_average_routes(app, get_db, current_user, login_required, beijing_now):
    from flask import request, jsonify

    @app.route("/api/statistics/averages")
    @login_required
    def lesson_averages():
        def positive_id(key):
            value = request.args.get(key)
            if value is None:
                return None
            if not re.fullmatch(r"[1-9][0-9]{0,17}", value):
                raise ValueError("班级和小组编号须为正整数")
            return int(value)
        try:
            cid, gid = positive_id("class_id"), positive_id("group_id")
            period, month = request.args.get("period", "month"), request.args.get("month")
            now = beijing_now()
            period_bounds(period, month, now)
        except (ValueError, TypeError):
            return jsonify({"error": "统计周期、月份或编号无效"}), 400
        db, uid = get_db(), current_user()["id"]
        db.execute("BEGIN")
        if gid:
            group = db.execute("SELECT g.class_id FROM groups g JOIN classes c ON c.id=g.class_id WHERE g.id=? AND c.owner_id=?", (gid,uid)).fetchone()
            if not group:
                return jsonify({"error": "小组不存在"}), 404
            if cid is not None and cid != group["class_id"]:
                return jsonify({"error": "小组不属于所选班级"}), 400
            cid = group["class_id"]
        classes = db.execute("SELECT id,name FROM classes WHERE owner_id=?" + (" AND id=?" if cid else "") + " ORDER BY id",
                             (uid,cid) if cid else (uid,)).fetchall()
        if cid and not classes:
            return jsonify({"error": "班级不存在"}), 404
        results = [calculate_class(db,uid,c,period,month,now) for c in classes]
        if gid:
            for result in results:
                result["class_group_count"] = len(result["groups"])
                result["groups"] = [g for g in result["groups"] if g["group_id"] == gid]
        return jsonify({"calculation_version": VERSION, "timezone": "Asia/Shanghai",
                        "as_of": now.astimezone(BJ).isoformat(), "period": period,
                        "month": (month or now.astimezone(BJ).strftime("%Y-%m")) if period == "month" else None,
                        "lesson_period_basis": "lesson_start_beijing_time",
                        "score_period_basis": "original_entry_time_beijing",
                        "classes": results})
