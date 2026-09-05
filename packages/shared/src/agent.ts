import { z } from 'zod'
import { ExtractedCitation, ExtractedItem } from './extract.ts'
import { Confidence, DatePrecision, ItemStatus, ItemType } from './item.ts'

/**
 * 条目归属项目的三选一。前两种必须带 quote——quote 与条目字段的引用共用同一段逐字校验，
 * 意思是：不能凭氛围归类，也不能凭氛围建项目。none 是正常状态（未归类），不是待办。
 */
export const ProjectRef = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('existing'),
    projectId: z.string().min(1),
    /** 必须逐字出现在当前碎片原文里。 */
    quote: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal('new'),
    name: z.string().min(1),
    /** 必须逐字出现在当前碎片原文里——原文里得出现一个可命名的长期事项才建。 */
    quote: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal('none'),
  }).strict(),
])
export type ProjectRef = z.infer<typeof ProjectRef>

/**
 * createItem 工具的参数 schema。原来发给 API 的抽取 response_format，现在这份 schema
 * 同时是三样东西：strict 工具参数、TS 类型、入库前的校验器。逐字校验在工具执行时做，
 * 失败作为工具结果返回，让模型改这一条，而不是作废整批。
 */
export const CreateItemInput = ExtractedItem.extend({
  project: ProjectRef,
}).strict()
export type CreateItemInput = z.infer<typeof CreateItemInput>

/** updateItem 的 patch：一次只改模型认为要改的字段。 */
export const UpdateItemPatch = z.object({
  type: ItemType.optional(),
  title: z.string().optional(),
  starts_at: z.string().nullable().optional(),
  due_at: z.string().nullable().optional(),
  date_precision: DatePrecision.nullable().optional(),
  date_raw: z.string().nullable().optional(),
  recurrence: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  confidence: Confidence.optional(),
  status: ItemStatus.optional(),
  project: ProjectRef.optional(),
})
export type UpdateItemPatch = z.infer<typeof UpdateItemPatch>

export const UpdateItemInput = z.object({
  id: z.string().min(1),
  patch: UpdateItemPatch,
  /** 这次更新依据的原文片段。缺省时只改字段、不追加引用。 */
  citations: z.array(ExtractedCitation).optional(),
})
export type UpdateItemInput = z.infer<typeof UpdateItemInput>

export const DropItemInput = z.object({
  id: z.string().min(1),
  reason: z.string().optional(),
})
export type DropItemInput = z.infer<typeof DropItemInput>

export const GetItemInput = z.object({ id: z.string().min(1) })
export type GetItemInput = z.infer<typeof GetItemInput>

export const GetProjectInput = z.object({ id: z.string().min(1) })
export type GetProjectInput = z.infer<typeof GetProjectInput>

export const SearchItemsInput = z.object({
  query: z.string().min(1),
  from: z.string().nullable(),
  to: z.string().nullable(),
})
export type SearchItemsInput = z.infer<typeof SearchItemsInput>

export type AgentToolName =
  | 'getItem' | 'searchItems' | 'getProject'
  | 'createItem' | 'updateItem' | 'dropItem'

export type AgentToolArgs =
  | { tool: 'getItem'; args: GetItemInput }
  | { tool: 'searchItems'; args: SearchItemsInput }
  | { tool: 'getProject'; args: GetProjectInput }
  | { tool: 'createItem'; args: CreateItemInput }
  | { tool: 'updateItem'; args: UpdateItemInput }
  | { tool: 'dropItem'; args: DropItemInput }

/**
 * 供 strict 工具参数与「重跑严格模式断言」用的 schema 产物。
 * 只在 createItem 上要求 strict：它是唯一一份会被我们当入库契约打的 schema。
 */
export function createItemJsonSchema() {
  return z.toJSONSchema(CreateItemInput, { target: 'draft-2020-12' })
}

/** 供 agent 循环登记工具用。非 createItem 的工具用非 strict schema 即可。 */
export function agentToolParameters(tool: AgentToolName): unknown {
  switch (tool) {
    case 'getItem': return z.toJSONSchema(GetItemInput, { target: 'draft-2020-12' })
    case 'searchItems': return z.toJSONSchema(SearchItemsInput, { target: 'draft-2020-12' })
    case 'getProject': return z.toJSONSchema(GetProjectInput, { target: 'draft-2020-12' })
    case 'createItem': return createItemJsonSchema()
    case 'updateItem': return z.toJSONSchema(UpdateItemInput, { target: 'draft-2020-12' })
    case 'dropItem': return z.toJSONSchema(DropItemInput, { target: 'draft-2020-12' })
  }
}
