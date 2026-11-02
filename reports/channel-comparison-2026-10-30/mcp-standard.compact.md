[activeProject: 元数据-LLM-WIKI (c5248ab7-9524-46b4-9477-be2dbe393c58)]

# LLM Wiki Agent response

Session: api_05ed62cf-cd25-4f15-ae17-61aa155a2ce7
Mode: standard
Project: c5248ab7-9524-46b4-9477-be2dbe393c58
Usage: promptChars=71964, completionChars=2130, references=12

imeta 是 BIP 平台的元数据引擎（元数据组件库/SDK），围绕元数据的建模、存储与查询提供核心能力。知识库中没有名为 “imeta” 的独立主题页，以下结论由相关页面汇总：

1. **组件定位与结构**：旧版总览（wiki/legacy/营销云领域元数据体系总览（2016-2017 旧版）.md，注意为 2016-2017 历史资料）描述了 imeta 组件结构：core（元数据结构）、io（元数据加载、保存、模型转换）、orm（数据库增删改查、查询方案解析）、biz（业务基类、业务校验、Json 序列化、导入导出）、tpl（代码/文档/测试生成）、Spring.*（Spring 集成）。FAQ 页（wiki/faqs/元数据相关问题排查指引.md）也把 imeta 与“元数据、元数据服务、特征、元数据SDK”并列为独立模块。

2. **查询能力（当前知识库中 imeta 内容最集中的维度）**：imeta 提供 QuerySchema 查询 API，将查询 Schema 转为 SQL 并获取实体，整体链路见 wiki/designs/imeta QuerySchema转SQL与实体获取流程.md；其 Spring 自动装配与 QueryConfiguration 构建见 wiki/designs/imeta Spring 装配与查询核心生命周期.md；配置参数（如查询仓、执行路由、EnableElasticAutoCompose 等）的能力边界见 wiki/constraints/imeta 查询配置参数与能力边界.md。

3. **与开发框架的关系**：wiki/concepts/MDD 与 YPD 调用 imeta 查询的入口与职责边界.md 说明——YPD 将 QuerySchema 查询完整交给 imeta 执行，MDD 仅借用 QuerySqlBuilder 生成 QuerySqlStruct，SQL 执行与结果处理由 MDD 自行接管（该页论断来自来源文档描述，未标注源码验证）。

**证据边界**：imeta 的模块划分来自标注为历史版本的总览页，当前版本的组件结构未经源码验证；知识库现有页面主要覆盖 imeta 的查询链路、配置约束与升级限制（另见 wiki/constraints/imeta升级与二开适配限制.md）。如需更完整的 imeta 定义页（如建模、发布、存储管理能力），现有 wiki 尚无对应主题页，属于知识缺口。

## References
1. imeta 升级与二开适配限制
   Kind: wiki
   Path: wiki/constraints/imeta升级与二开适配限制.md
   Score: 0.016393
   Snippet: # imeta 升级与二开适配限制

本页集中说明 V5/R6 升级后 imeta 相关的使用限制、禁止配置与二开适配要求。约束来源于 2026 年 1 月支持工单结论，属来源事实，适用版本以各条目标注为准。
2. KKZC-73200：R6 升级 V5 后 imeta 查询仓配置报错 RoleA of composition
   Kind: wiki
   Path: wiki/cases/KKZC-73200-R6升级V5后imeta查询仓配置报错.md
   Score: 0.015873
   Snippet: 
删除 imeta.xml 里关于查询仓的配置；同时要求框架修改脚手架，防止更多项目升级出现问题。

3. MDD 与 YPD 调用 imeta 查询的入口与职责边界
   Kind: wiki
   Path: wiki/concepts/MDD 与 YPD 调用 imeta 查询的入口与职责边界.md
   Score: 0.015625
   Snippet: 
本页说明 MDD 与 YPD 两个开发框架在查询场景下与 imeta 查询链路的区别与联系：二者的查询入口分别是什么、各自借用 imeta 的哪一段能力、又自己接管哪一段。论断来自来源文档的断言性描述，未标注源码验证。

4. imeta 查询配置参数与能力边界
   Kind: wiki
   Path: wiki/constraints/imeta 查询配置参数与能力边界.md
   Score: 0.015385
   Snippet: ## 查询仓和执行路由参数
5. 元数据组件（Meta Component）
   Kind: wiki
   Path: wiki/topics/元数据组件（Meta Component）.md
   Score: 0.016393
   Snippet: # 元数据组件（Meta Component）
本页为元数据组件的知识总入口，说明其定义、组成对象、层级关系与URI构成规则，关联相关存储、约束、排查类知识页面。
6. 元数据组件建模与配置核心约束
   Kind: wiki
   Path: wiki/constraints/元数据组件建模与配置核心约束.md
   Score: 0.015873
   Snippet: ## 关联知识
- 组件定义：[[元数据组件（Meta Component）]]
- 领域语义：[[元数据领域（Domain）]]
- 物理存储：[[md_meta_component 表结构]]
- 通用建模约束：[[元数据建模核心约束]]
- 排查指引：[[元数据组件与领域相关问题排查指引]]
7. 元数据设置常见问题（association误用与组件划分）
   Kind: wiki
   Path: wiki/faqs/元数据设置常见问题（association误用与组件划分）.md
   Score: 0.015625
   Snippet: ---
type: faq
title: 元数据设置常见问题（association误用与组件划分）
created: 2026-10-20
updated: 2026-10-20
related: [营销云领域元数据体系总览（2016-2017 旧版）, 元数据主子关系建模与配置核心约束, 元数据组件建模与配置核心约束]
sources: ["领域元数据设计及应用文档.pdf"]
tags: ["legacy", "association", "组件划分", "营销云", "module/metadata-relation"]
---
8. IMetadataCustomerDocRpcService 自定义档案元数据RPC接口
   Kind: wiki
   Path: wiki/interfaces/IMetadataCustomerDocRpcService-自定义档案元数据RPC接口.md
   Score: 0.015385
   Snippet: ### 参数定义
| 参数名                       | 参数说明          | 类型             | 必填 | 默认值   | 样例                           |
|---------------------------|---------------|----------------|----|-------|------------------------------|
| docComponentUri           | 自定义档案元数据组件uri | String         | 是  | -     | bd.customerdoc_test1         |

9. 营销云领域元数据体系总览（2016-2017 旧版）
   Kind: wiki
   Path: wiki/legacy/营销云领域元数据体系总览（2016-2017 旧版）.md
   Score: 0.016129
   Snippet: ## imeta 组件结构

- core：元数据结构
- io：元数据加载、保存、不同模型间转换（db->imeta，关系用 levenshtein 匹配）
- orm：数据库增删改查、查询方案结构及解析
- biz：业务基类、业务校验（非空、格式、唯一）、主外键设置、Json 序列化、导入导出
- tpl：代码、文档、测试用例及测试数据生成
- Spring.*：Spring 集成
10. 元数据相关问题排查指引
   Kind: wiki
   Path: wiki/faqs/元数据相关问题排查指引.md
   Score: 0.015873
   Snippet: 
本页面围绕元数据、元数据服务、特征、imeta、元数据SDK等模块的高频问题，提供通用排查路径、判断条件、验证SQL与解决方案。QuerySchema 结构定义见 [[QuerySchema结构定义与典型使用示例集]]，SQL 构建流程见 [[imeta 查询 SQL 构建流程]]。

11. 元数据组件 scope 字段引用约束
   Kind: wiki
   Path: wiki/constraints/元数据组件 scope 字段引用约束.md
   Score: 0.015625
   Snippet: ## 关联知识
- 组件定义：[[元数据组件（Meta Component）]]
- 表结构：[[md_meta_component 表结构]]
- 排查指引：[[元数据组件与领域相关问题排查指引]]
12. 计算列元数据定义与存储
   Kind: wiki
   Path: wiki/data-models/计算列元数据定义与存储.md
   Score: 0.015385
   Snippet: 
- Entity 上增加计算列属性集合 `calculatedAttributes`，描述某个实体有哪些计算列；
- Property 上增加 `isCalculated()` 方法，描述当前属性是否是计算列；
- 因为计算列定义在元数据属性上且有 type 描述，天然支持穿透语义；
- 采用新增方法方式，避免对现有业务产生影响。

```mermaid
classDiagram
    class Entity {
        - List<Property> attrs;
        - List<Property> calculatedAttributes;
        + getAttribute(String name) Property
        + getCalculatedAttributes() List<Property>
        + getCalculatedAttribute(String name) Property
    }
    class Property {
        - String name
        + type() Type
        + isCalculated() boolean
    }
    Entity "1" o-- "*" Property: attrs/calculate

