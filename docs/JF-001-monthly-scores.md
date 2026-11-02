# JF-001 月度积分

## 统计口径

- 累计记分板保持使用 groups.score，奖励继续使用原有累计分规则。
- 月度积分为北京时间自然月内有效记分的 delta 净和，区间左闭右开。
- 原记录的 created_at 已按当前业务格式保存为北京时间；新单组、全班记分显式生成北京时间，整批使用同一时间。
- 撤销使原月份记录失效，包括跨月撤销；不把它算作撤销当月的普通扣分。
- 清零和直接设置分数不是教学记分，不进入月度净分；清零不会删除新账本内的历史。
- 不生成课堂、不调整奖励、不改写既有归档。

## 数据库升级

新增 monthly_score_entries：
id、transaction_id（唯一）、owner_id、class_id、group_id、delta、occurred_at、voided_at。

- 增加按账号/时间/小组及账号/班级/时间的索引。
- transactions 的 INSERT 触发器在原事务中写入月度明细。
- 首次启动仅复制现存有效流水，不更改原表记录；重复启动不重复复制或激活已撤销记录。
- 撤销事务标记对应明细 voided_at，再执行原累计分回退及旧日志删除。
- 月度表不对旧班组使用级联删除。
- 当前接口展示当前班组的统计。已删除班组及导入重建 ID 前的历史记录保留在月度表，但不会自动按同名合并到新班组。跨导入实体的历史排行榜属于后续稳定身份改造范围。
- 现有 v5 JSON 不是完整数据库备份，不携带月度账本；完整恢复应使用一致性 SQLite 备份。
- 旧流水已被删除且没有其他证据时，不补造记分。Qiuzizhao 上线前已逐组核对现存流水与累计分一致。

## 接口与界面

GET /api/statistics/monthly?month=YYYY-MM

返回 month、current_month、timezone、scores（group_id/class_id/score）。省略 month 时为北京时间当月。
账号隔离、合法月份校验；空月份返回各组零分。

主页三个排行榜复用原有展示，增加当月、历史和原生月份选择器：
- 当月跟随北京时间自然月自动切换；
- 指定月份固定不变；
- 历史使用现有累计分；
- 月度数据以服务器为准，未连接时不将本地累计缓存误显示为月度分数；
- 本机操作成功、另一设备 SSE 更新、重连对账都会刷新月度数据；
- 月界检测间隔 1 秒，后台页恢复后核对，15 秒周期性补偿刷新。

## 测试

仅使用临时数据库和测试服务器：

    python -m unittest discover -s tests -p 'test_*.py'
    node --test tests/sse-score-voice.test.cjs
    PLAYWRIGHT_MODULE=/path/to/playwright-core CHROME_PATH=/path/to/chrome node --test tests/startup-cache.browser.cjs
    TEST_PYTHON=/path/to/python PLAYWRIGHT_MODULE=/path/to/playwright-core CHROME_PATH=/path/to/chrome node --test tests/monthly.browser.cjs

monthly_server.py 是隔离测试夹具，含自动登录和时钟控制，不能部署为生产入口。

上线前另在生产数据的内存副本演练新增表与幂等回填，并逐表指纹核对原始表不变。
