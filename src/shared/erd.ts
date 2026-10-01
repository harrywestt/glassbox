/**
 * The project's database as entities and how they relate, read from the code that defines it:
 * EF Core model snapshots, Prisma schemas, or SQL CREATE TABLE migrations.
 */

export type ErdColumn = { name: string; type: string; required: boolean; key?: boolean; fk?: boolean }

export type ErdEntity = {
  /** Full name (namespace-qualified for EF Core), unique. */
  id: string
  /** Short name, e.g. Control. */
  name: string
  table?: string
  schema?: string
  /** Where it's defined: the module, context or file it belongs to. */
  group: string
  columns: ErdColumn[]
  /** The file that defines it (relative to the repo root), when found. */
  file?: string
}

/**
 * `from` holds the foreign key `column` pointing at `to`. `many`: `to` has many of `from`.
 * `inferred`: not declared, only a column named after an entity in another module (FrameworkId).
 */
export type ErdRelation = { from: string; to: string; column?: string; nav?: string; many: boolean; required?: boolean; inferred?: boolean }

export type Erd = { root: string; source: 'ef' | 'prisma' | 'sql' | 'none'; entities: ErdEntity[]; relations: ErdRelation[]; error?: string }

/** Claude's pick of the entities an area of the database covers ("controls v2"), with why. */
export type ErdFocus = { entities: string[]; why?: string; error?: string }
