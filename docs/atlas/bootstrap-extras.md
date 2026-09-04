# Bootstrap extras

Candidates raised during the atlas bootstrap interview on 2026-09-04 that the
user chose not to record. Each cites its evidence; write a record later if one
becomes settled or worth tracking.

## Decision candidates skipped

- 陪伴与规划融合，陪伴是产品表面、画像是引擎；LLM 位于评估层而非对话皮肤。
  Source: docs/伴学计划-策略与产品形态.md §1 策略. Skipped by user without a stated
  reason; the product-form question is tracked in [[003-product-form-open]].
- 入库按置信度三档分流：高置信度直接入库，中置信度入库标「猜的」，低置信度进待确认队列且产品不催。
  Source: docs/信息采集模块-设计文档.md §1 原则 4, §4.3.
- 校历是日期解析的硬依赖，静态导入一次，优先于任何自动同步。
  Source: docs/信息采集模块-设计文档.md §2.3.
- 精力曲线用 chronotype 加约 90 分钟超日节律做初始先验，再用专注记录修正。
  Source: docs/伴学计划-策略与产品形态.md §2.6.

## Question candidates skipped

- 手机端做网页、小程序还是 PWA。Source: docs/信息采集模块-设计文档.md §9.
  User's view during interview: probably an app; not worth tracking.
- LLM 与图片理解模型选型，成本与速度待测。Source: docs/信息采集模块-设计文档.md §9.
  User's view: not a hackathon-stage problem.
- 校历数据从哪里拿。Source: docs/信息采集模块-设计文档.md §9 (「需要今晚确认」).
