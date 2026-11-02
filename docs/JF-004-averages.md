# JF-004 课均积分统计引擎

本阶段仅增加只读计算模块和接口，不改排行榜页面、不迁移数据库、不保存静态课均值。

## 接口

GET /api/statistics/averages?period=month&month=2026-09&class_id=1
GET /api/statistics/averages?period=history&class_id=1
GET /api/statistics/averages?period=month&month=2026-09&group_id=1

- period默认month；month省略时为北京时间当月；history不接受month参数。
- class_id/group_id可省略，省略则查询本账号全部当前班级。单组过滤不会改变班级总分或共享分母。
- group_id与class_id不匹配返回400，跨账号或不存在对象返回404，未登录返回401。
- 原始事件存量来自monthly_score_entries；voided_at非空排除；管理调整不成为教学积分。
- 一次读取事务保证所有班组、课堂与明细来自同一数据库快照。
- 查询截至as_of，北京时间月界左闭右开；未发生的手动课堂不计入实际课堂数。

## 两种净分与质量

period_net_score：周期内全部有效教学净积分。
recognized_net_score：其中可归入周期内“已识别”课堂且位于其边界内的净积分。
unresolved_net_score：上述两者之差。

lesson_count：周期内已识别课堂数。全部小组共享同一班级课次数，不按各组是否记分分别计数。
手动补建的零记分课堂计数；已全部撤销的自动窗口不计数，与JF-003一致。
待校正、未知课堂不当作已确认的实际课次数。

完整归属条件下：
- 小组average = 小组period_net_score / 班级lesson_count。
- 班级average = 全部小组period_net_score之和 / 班级lesson_count。
- 绝不使用各组average再简单平均作为班级课均。

存在未归属有效积分、待校正/未知课堂、错误归属、重叠时：
- average=null，不把可能错误的全周期数字作为正式结果。
- partial_average=recognized_net_score / lesson_count，明确仅为已识别范围暂算。
- quality说明原因；exclusions逐笔列出有效积分未进入已识别课堂分子的原因。
- 无已识别课堂时，两个平均值均为null，不用0冒充未知。

即使记录全部归属，历史完整性也返回historical_completeness=not_attested。
系统只能依据已登记课堂计算，无法从“当天没有积分”证明当天没上课。缺课应手动补建；本接口不虚构课表和缺失课堂。
quality.status=recorded_only仅表示基于已登记且已识别的记录可计算，不承诺完整授课史。

## 时间与跨月

- 分子按原始教学发生时间的北京时间自然月，不跟随编辑窗口修改原始时间。
- 课堂分母按开始时间所属月份，每堂课只记一次。
- 跨月窗口中的次月积分不会重复计算上一月课次；次月返回lesson_outside_period提示，阻止静默混算。
- 可通过拆分课堂或校正边界处理异常跨月窗口，之后重新计算。
- 历史模式对所有已发生有效教学记录及已识别课堂计算，不把groups.score中的期初/清零/人工调整硬塞入分子。
- 撤销回修原月份；自动测试窗口全部撤销后不计为实际课堂。手动零记分课堂仍保留。
- 学校“全校”仍指当前账号的班组，不跨账号。

## 解释与精度

每个班级返回classes[].lessons、每个小组返回groups[].lessons。
其中包含课堂ID、起止时间、记录ID、原transaction_id、分值、发生时间与原因。
可逐笔核对：明细之和=每堂课净分；各堂课之和=recognized_net_score。
未受影响小组在同堂课也有零分贡献，分母一致。

average/partial_average显示精度两位，Decimal ROUND_HALF_UP；exact_ratio/partial_ratio保留整数分子分母。
后续排名应比较原始比值，不以两位小数排序。
data_revision由原始明细、课堂版本和归属生成，修正后重新计算；没有平均值缓存和落库。

## 测试

tests/test_averages.py覆盖：
4/5节课、零记分课、无记分组、负分、月/历史区间、已识别分子解释、缺失/未知、未归属、
跨月撤销、边界调整、拆合改变分母、零分母、跨月课堂、未来课堂排除、读操作无副作用、
单组过滤、账号隔离、重叠数据失败关闭、重复计算一致性。

原月度、课堂编辑、SSE、启动缓存测试继续执行。

## 数据保护

不增加或修改数据库表、字段、索引；不修改原始数据、课堂归属、奖励与旧归档。
原有初始化行为继续保留；新接口本身只读，不发布SSE、不写审计或平均值。
