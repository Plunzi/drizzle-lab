import chalk from "chalk";
import { getTableName, is, Many, SQL } from "drizzle-orm";
import type { IndexedColumn } from "drizzle-orm/pg-core";
import {
  getMaterializedViewConfig,
  getTableConfig,
  getViewConfig,
  PgColumn,
  PgDialect,
  PgEnumColumn,
  PgRole,
  PgView,
  uniqueKeyName,
} from "drizzle-orm/pg-core";

import { schemaToDrizzleObjects, type DrizzleObjects } from "./drizzle-objects";
import type { PartialConfig } from "../../config/loader.node";
import { DrizzleLab } from "../../extensions/symbols";
import type { DrizzleSchema } from "../../internal/global";
import { getColumnCasing, sqlToStr } from "../../internal/helpers";
import type { Relation } from "../../internal/relations";
import { withStyle } from "../../internal/style";
import { escapeSingleQuotes, splitSqlStatements } from "../../sql/utils";
import { importFromDatabase } from "../loader/database";
import type {
  CheckConstraint,
  Column,
  Enum,
  ForeignKey,
  Index,
  IndexColumnType,
  Snapshot,
  Policy,
  PrimaryKey,
  Role,
  Sequence,
  Table,
  UniqueConstraint,
  View,
} from "../schema";
import { isPgArrayType, vectorOps } from "../utils";

// fork: drizzle-kit/src/serializer/pgSerializer.ts

const indexName = (tableName: string, columns: string[]) => {
  return `${tableName}_${columns.join("_")}_index`;
};

function stringFromIdentityProperty(
  field: string | number | undefined,
): string | undefined {
  return typeof field === "string"
    ? (field as string)
    : typeof field === "undefined"
      ? undefined
      : String(field);
}

function maxRangeForIdentityBasedOn(columnType: string) {
  return columnType === "integer"
    ? "2147483647"
    : columnType === "bigint"
      ? "9223372036854775807"
      : "32767";
}

function minRangeForIdentityBasedOn(columnType: string) {
  return columnType === "integer"
    ? "-2147483648"
    : columnType === "bigint"
      ? "-9223372036854775808"
      : "-32768";
}

function buildArrayString(array: any[], sqlType: string): string {
  sqlType = sqlType.split("[")[0];
  const values = array
    .map((value) => {
      if (typeof value === "number" || typeof value === "bigint") {
        return value.toString();
      } else if (typeof value === "boolean") {
        return value ? "true" : "false";
      } else if (Array.isArray(value)) {
        return buildArrayString(value, sqlType);
      } else if (value instanceof Date) {
        if (sqlType === "date") {
          return `"${value.toISOString().split("T")[0]}"`;
        } else if (sqlType === "timestamp") {
          return `"${value.toISOString().replace("T", " ").slice(0, 23)}"`;
        } else {
          return `"${value.toISOString()}"`;
        }
      } else if (typeof value === "object") {
        return `"${JSON.stringify(value).replaceAll('"', '\\"')}"`;
      }

      return `"${value}"`;
    })
    .join(",");

  return `{${values}}`;
}

/*
 * Generate a snapshot from the Drizzle schema.
 * @param schema - The Drizzle schema to generate a snapshot from.
 * @param config - The Drizzle configuration to use for the snapshot.
 * @returns A snapshot of the Drizzle schema.
 */
export function schemaToSnapshot(
  schema: DrizzleSchema,
  config: PartialConfig = {},
) {
  return drizzleObjectsToSnapshot(schemaToDrizzleObjects(schema), {
    ...config,
    dialect: "postgresql",
  });
}

/**
 * Generate a snapshot from the Drizzle objects.
 * @param drizzleObjects - The Drizzle objects to generate a snapshot from.
 * @param config - The Drizzle configuration to use for the snapshot.
 * @returns A snapshot of the Drizzle objects.
 */
export function drizzleObjectsToSnapshot(
  {
    tables,
    enums,
    schemas,
    sequences,
    roles,
    policies,
    views,
    matViews,
    relations,
  }: DrizzleObjects,
  config: PartialConfig = {},
): Snapshot {
  const { casing, schemaFilter, entities } = config;
  const projectId = config?.projectId || "drizzle-lab";
  const dialect = new PgDialect({ casing });
  const result: Record<string, Table> = {};
  const resultViews: Record<string, View> = {};
  const sequencesToReturn: Record<string, Sequence> = {};
  const rolesToReturn: Record<string, Role> = {};
  // these policies are separate objects that were linked to a table outside of it
  const policiesToReturn: Record<string, Policy> = {};

  // This object stores unique names for indexes and will be used to detect if you have the same names for indexes
  // within the same PostgreSQL schema
  const indexesInSchema: Record<string, string[]> = {};

  for (const table of tables) {
    // This object stores unique names for checks and will be used to detect if you have the same names for checks
    // within the same PostgreSQL table
    const checksInTable: Record<string, string[]> = {};

    const {
      name: tableName,
      columns,
      indexes,
      foreignKeys,
      checks,
      schema,
      primaryKeys,
      uniqueConstraints,
      policies,
      enableRLS,
    } = getTableConfig(table);

    if (schemaFilter && !schemaFilter.includes(schema ?? "public")) {
      continue;
    }

    const columnsObject: Record<string, Column> = {};
    const indexesObject: Record<string, Index> = {};
    const checksObject: Record<string, CheckConstraint> = {};
    const foreignKeysObject: Record<string, ForeignKey> = {};
    const primaryKeysObject: Record<string, PrimaryKey> = {};
    const uniqueConstraintObject: Record<string, UniqueConstraint> = {};
    const policiesObject: Record<string, Policy> = {};
    /* lab extension */
    const tableRelations: Array<Relation> = [];

    columns.forEach((column) => {
      const name = getColumnCasing(column, casing);
      const notNull: boolean = column.notNull;
      const primaryKey: boolean = column.primary;
      const sqlTypeLowered = column.getSQLType().toLowerCase();

      const typeSchema = is(column, PgEnumColumn)
        ? column.enum.schema || "public"
        : undefined;
      const generated = column.generated;
      const identity = column.generatedIdentity;

      const increment =
        stringFromIdentityProperty(identity?.sequenceOptions?.increment) ?? "1";
      const minValue =
        stringFromIdentityProperty(identity?.sequenceOptions?.minValue) ??
        (parseFloat(increment) < 0
          ? minRangeForIdentityBasedOn(column.columnType)
          : "1");
      const maxValue =
        stringFromIdentityProperty(identity?.sequenceOptions?.maxValue) ??
        (parseFloat(increment) < 0
          ? "-1"
          : maxRangeForIdentityBasedOn(column.getSQLType()));
      const startWith =
        stringFromIdentityProperty(identity?.sequenceOptions?.startWith) ??
        (parseFloat(increment) < 0 ? maxValue : minValue);
      const cache =
        stringFromIdentityProperty(identity?.sequenceOptions?.cache) ?? "1";

      /* lab extension */
      const enumValues = column.enumValues;
      const defaultFn = column.defaultFn?.toString();
      const onUpdateFn = column.onUpdateFn?.toString();
      const description = table[DrizzleLab]?.explain?.columns?.[name];
      const jsonShape = JSON.stringify(
        table[DrizzleLab]?.explain?.jsonShapes?.[name],
        null,
        2,
      );

      const columnToSet: Column = {
        name,
        type: column.getSQLType(),
        typeSchema: typeSchema,
        primaryKey,
        notNull,
        generated: generated
          ? {
              as: is(generated.as, SQL)
                ? dialect.sqlToQuery(generated.as as SQL).sql
                : typeof generated.as === "function"
                  ? dialect.sqlToQuery(generated.as() as SQL).sql
                  : (generated.as as any),
              type: "stored",
            }
          : undefined,
        identity: identity
          ? {
              type: identity.type,
              name: identity.sequenceName ?? `${tableName}_${name}_seq`,
              schema: schema ?? "public",
              increment,
              startWith,
              minValue,
              maxValue,
              cache,
              cycle: identity?.sequenceOptions?.cycle ?? false,
            }
          : undefined,
        /* lab extension */
        description,
        enumValues,
        defaultFn,
        onUpdateFn,
        jsonShape,
      };

      if (column.isUnique) {
        const existingUnique = uniqueConstraintObject[column.uniqueName!];
        if (typeof existingUnique !== "undefined") {
          console.log(
            `\n${withStyle.errorWarning(`We\'ve found duplicated unique constraint names in ${chalk.underline.blue(
              tableName,
            )} table. 
          The unique constraint ${chalk.underline.blue(
            column.uniqueName,
          )} on the ${chalk.underline.blue(
            name,
          )} column is conflicting with a unique constraint name already defined for ${chalk.underline.blue(
            existingUnique.columns.join(","),
          )} columns\n`)}`,
          );
          throw new Error("Duplicated unique constraint name");
        }
        uniqueConstraintObject[column.uniqueName!] = {
          name: column.uniqueName!,
          nullsNotDistinct: column.uniqueType === "not distinct",
          columns: [columnToSet.name],
        };
      }

      if (column.default !== undefined) {
        if (is(column.default, SQL)) {
          columnToSet.default = sqlToStr(column.default, casing);
        } else {
          if (typeof column.default === "string") {
            columnToSet.default = `'${escapeSingleQuotes(column.default)}'`;
          } else {
            if (sqlTypeLowered === "jsonb" || sqlTypeLowered === "json") {
              columnToSet.default = `'${JSON.stringify(column.default)}'::${sqlTypeLowered}`;
            } else if (column.default instanceof Date) {
              if (sqlTypeLowered === "date") {
                columnToSet.default = `'${column.default.toISOString().split("T")[0]}'`;
              } else if (sqlTypeLowered === "timestamp") {
                columnToSet.default = `'${column.default.toISOString().replace("T", " ").slice(0, 23)}'`;
              } else {
                columnToSet.default = `'${column.default.toISOString()}'`;
              }
            } else if (
              isPgArrayType(sqlTypeLowered) &&
              Array.isArray(column.default)
            ) {
              columnToSet.default = `'${buildArrayString(column.default, sqlTypeLowered)}'`;
            } else {
              // Should do for all types
              // columnToSet.default = `'${column.default}'::${sqlTypeLowered}`;
              columnToSet.default = column.default;
            }
          }
        }
      }
      columnsObject[name] = columnToSet;
    });

    primaryKeys.map((pk) => {
      const originalColumnNames = pk.columns.map((c) => c.name);
      const columnNames = pk.columns.map((c) => getColumnCasing(c, casing));

      let name = pk.getName();
      if (casing !== undefined) {
        for (let i = 0; i < originalColumnNames.length; i++) {
          name = name.replace(originalColumnNames[i], columnNames[i]);
        }
      }

      primaryKeysObject[name] = {
        name,
        columns: columnNames,
      };
    });

    uniqueConstraints?.map((unq) => {
      const columnNames = unq.columns.map((c) => getColumnCasing(c, casing));

      const name = unq.name ?? uniqueKeyName(table, columnNames);

      const existingUnique = uniqueConstraintObject[name];
      if (typeof existingUnique !== "undefined") {
        console.log(
          `\n${withStyle.errorWarning(
            `We\'ve found duplicated unique constraint names in ${chalk.underline.blue(tableName)} table. 
        The unique constraint ${chalk.underline.blue(name)} on the ${chalk.underline.blue(
          columnNames.join(","),
        )} columns is conflicting with a unique constraint name already defined for ${chalk.underline.blue(
          existingUnique.columns.join(","),
        )} columns\n`,
          )}`,
        );
        throw new Error(
          `We've found duplicated unique constraint names in ${chalk.underline.blue(tableName)} table.`,
        );
      }

      uniqueConstraintObject[name] = {
        name: unq.name!,
        nullsNotDistinct: unq.nullsNotDistinct,
        columns: columnNames,
      };
    });

    const fks: ForeignKey[] = foreignKeys.map((fk) => {
      const tableFrom = tableName;
      const onDelete = fk.onDelete;
      const onUpdate = fk.onUpdate;
      const reference = fk.reference();

      const tableTo = getTableName(reference.foreignTable);
      // TODO: resolve issue with schema undefined/public for db push(or squasher)
      // getTableConfig(reference.foreignTable).schema || "public";
      const schemaTo = getTableConfig(reference.foreignTable).schema;

      const originalColumnsFrom = reference.columns.map((it) => it.name);
      const columnsFrom = reference.columns.map((it) =>
        getColumnCasing(it, casing),
      );
      const originalColumnsTo = reference.foreignColumns.map((it) => it.name);
      const columnsTo = reference.foreignColumns.map((it) =>
        getColumnCasing(it, casing),
      );

      let name = fk.getName();
      if (casing !== undefined) {
        for (let i = 0; i < originalColumnsFrom.length; i++) {
          name = name.replace(originalColumnsFrom[i], columnsFrom[i]);
        }
        for (let i = 0; i < originalColumnsTo.length; i++) {
          name = name.replace(originalColumnsTo[i], columnsTo[i]);
        }
      }

      return {
        name,
        tableFrom,
        tableTo,
        schemaTo,
        columnsFrom,
        columnsTo,
        onDelete,
        onUpdate,
      } as ForeignKey;
    });

    fks.forEach((it) => {
      foreignKeysObject[it.name] = it;
    });

    indexes.forEach((value) => {
      const columns = value.config.columns;

      let indexColumnNames: string[] = [];
      columns.forEach((it) => {
        if (is(it, SQL)) {
          if (typeof value.config.name === "undefined") {
            console.log(
              `\n${withStyle.errorWarning(
                `Please specify an index name in ${getTableName(value.config.table)} table that has "${dialect.sqlToQuery(it).sql}" expression. We can generate index names for indexes on columns only; for expressions in indexes, you need to specify the name yourself.`,
              )}`,
            );
            throw new Error(
              `Please specify an index name in ${getTableName(
                value.config.table,
              )} table that has "${dialect.sqlToQuery(it).sql}" expression. We can generate index names for indexes on columns only; for expressions in indexes, you need to specify the name yourself.`,
            );
          }
        }
        it = it as IndexedColumn;
        const name = getColumnCasing(it as IndexedColumn, casing);
        if (
          !is(it, SQL) &&
          it.type! === "PgVector" &&
          typeof it.indexConfig!.opClass === "undefined"
        ) {
          console.log(
            `\n${withStyle.errorWarning(
              `You are specifying an index on the ${chalk.blueBright(
                name,
              )} column inside the ${chalk.blueBright(
                tableName,
              )} table with the ${chalk.blueBright(
                "vector",
              )} type without specifying an operator class. Vector extension doesn't have a default operator class, so you need to specify one of the available options. Here is a list of available op classes for the vector extension: [${vectorOps
                .map((it) => `${chalk.underline(`${it}`)}`)
                .join(
                  ", ",
                )}].\n\nYou can specify it using current syntax: ${chalk.underline(
                `index("${value.config.name}").using("${value.config.method}", table.${name}.op("${vectorOps[0]}"))`,
              )}\n\nYou can check the "pg_vector" docs for more info: https://github.com/pgvector/pgvector?tab=readme-ov-file#indexing\n`,
            )}`,
          );
          throw new Error(
            `You are specifying an index on the ${
              name
            } column inside the ${tableName} table with the vector type without specifying an operator class. Vector extension doesn't have a default operator class, so you need to specify one of the available options. Here is a list of available op classes for the vector extension: [${vectorOps
              .map((it) => `${chalk.underline(`${it}`)}`)
              .join(", ")}].`,
          );
        }
        indexColumnNames.push(name);
      });

      const name = value.config.name
        ? value.config.name
        : indexName(tableName, indexColumnNames);

      let indexColumns: IndexColumnType[] = columns.map(
        (it): IndexColumnType => {
          if (is(it, SQL)) {
            return {
              expression: dialect.sqlToQuery(it, "indexes").sql,
              asc: true,
              isExpression: true,
              nulls: "last",
            };
          } else {
            it = it as IndexedColumn;
            return {
              expression: getColumnCasing(it as IndexedColumn, casing),
              isExpression: false,
              asc: it.indexConfig?.order === "asc",
              nulls: it.indexConfig?.nulls
                ? it.indexConfig?.nulls
                : it.indexConfig?.order === "desc"
                  ? "first"
                  : "last",
              opclass: it.indexConfig?.opClass,
            };
          }
        },
      );

      // check for index names duplicates
      if (typeof indexesInSchema[schema ?? "public"] !== "undefined") {
        if (indexesInSchema[schema ?? "public"].includes(name)) {
          console.log(
            `\n${withStyle.errorWarning(
              `We\'ve found duplicated index name across ${chalk.underline.blue(
                schema ?? "public",
              )} schema. Please rename your index in either the ${chalk.underline.blue(
                tableName,
              )} table or the table with the duplicated index name`,
            )}`,
          );
          throw new Error(
            `We've found duplicated index name across ${schema ?? "public"} schema. Please rename your index in either the ${tableName} table or the table with the duplicated index name`,
          );
        }
        indexesInSchema[schema ?? "public"].push(name);
      } else {
        indexesInSchema[schema ?? "public"] = [name];
      }

      indexesObject[name] = {
        name,
        columns: indexColumns,
        isUnique: value.config.unique ?? false,
        where: value.config.where
          ? dialect.sqlToQuery(value.config.where).sql
          : undefined,
        concurrently: value.config.concurrently ?? false,
        method: value.config.method ?? "btree",
        with: value.config.with ?? {},
      };
    });

    policies.forEach((policy) => {
      const mappedTo: string[] = [];

      if (!policy.to) {
        mappedTo.push("public");
      } else {
        if (policy.to && typeof policy.to === "string") {
          mappedTo.push(policy.to);
        } else if (policy.to && is(policy.to, PgRole)) {
          mappedTo.push(policy.to.name);
        } else if (policy.to && Array.isArray(policy.to)) {
          policy.to.forEach((it) => {
            if (typeof it === "string") {
              mappedTo.push(it);
            } else if (is(it, PgRole)) {
              mappedTo.push(it.name);
            }
          });
        }
      }

      if (policiesObject[policy.name] !== undefined) {
        console.log(
          `\n${withStyle.errorWarning(
            `We\'ve found duplicated policy name across ${chalk.underline.blue(
              tableKey,
            )} table. Please rename one of the policies with ${chalk.underline.blue(
              policy.name,
            )} name`,
          )}`,
        );
        throw new Error(
          `We've found duplicated policy name across ${tableKey} table. Please rename one of the policies with ${policy.name} name`,
        );
      }

      policiesObject[policy.name] = {
        name: policy.name,
        as: (policy.as?.toUpperCase() as Policy["as"]) ?? "PERMISSIVE",
        for: (policy.for?.toUpperCase() as Policy["for"]) ?? "ALL",
        to: mappedTo.sort(),
        using: is(policy.using, SQL)
          ? dialect.sqlToQuery(policy.using).sql
          : undefined,
        withCheck: is(policy.withCheck, SQL)
          ? dialect.sqlToQuery(policy.withCheck).sql
          : undefined,
      };
    });

    checks.forEach((check) => {
      const checkName = check.name;

      if (
        typeof checksInTable[`"${schema ?? "public"}"."${tableName}"`] !==
        "undefined"
      ) {
        if (
          checksInTable[`"${schema ?? "public"}"."${tableName}"`].includes(
            check.name,
          )
        ) {
          console.log(
            `\n${withStyle.errorWarning(
              `We\'ve found duplicated check constraint name across ${chalk.underline.blue(
                schema ?? "public",
              )} schema in ${chalk.underline.blue(
                tableName,
              )}. Please rename your check constraint in either the ${chalk.underline.blue(
                tableName,
              )} table or the table with the duplicated check contraint name`,
            )}`,
          );
          throw new Error(
            `We've found duplicated check constraint name across ${
              schema ?? "public"
            } schema in ${tableName} table. Please rename your check constraint in either the ${tableName} table or the table with the duplicated check contraint name`,
          );
        }
        checksInTable[`"${schema ?? "public"}"."${tableName}"`].push(checkName);
      } else {
        checksInTable[`"${schema ?? "public"}"."${tableName}"`] = [check.name];
      }

      checksObject[checkName] = {
        name: checkName,
        value: dialect.sqlToQuery(check.value).sql,
      };
    });

    const tableKey = `${schema ?? "public"}.${tableName}`;

    /* lab extension */
    const description = table[DrizzleLab]?.explain?.description;

    for (const config of relations.filter((r) => r.dbName === tableName)) {
      for (const relation of Object.values(config.relations)) {
        tableRelations.push({
          type: is(relation, Many) ? "many" : "one",
          fieldName: relation.fieldName,
          relationName: relation.relationName || relation.fieldName,
          referencedTableName: relation.referencedTableName,
        });
      }
    }

    result[tableKey] = {
      name: tableName,
      schema: schema ?? "",
      columns: columnsObject,
      indexes: indexesObject,
      foreignKeys: foreignKeysObject,
      compositePrimaryKeys: primaryKeysObject,
      uniqueConstraints: uniqueConstraintObject,
      policies: policiesObject,
      checkConstraints: checksObject,
      isRLSEnabled: enableRLS,
      /* lab extension */
      description,
      relations: tableRelations,
    };
  }

  for (const policy of policies) {
    // @ts-ignore
    if (!policy._linkedTable) {
      console.log(
        `\n${withStyle.errorWarning(
          `"Policy ${policy.name} was skipped because it was not linked to any table. You should either include the policy in a table or use .link() on the policy to link it to any table you have. For more information, please check:`,
        )}`,
      );
      continue;
    }

    // @ts-ignore
    const tableConfig = getTableConfig(policy._linkedTable);

    const tableKey = `${tableConfig.schema ?? "public"}.${tableConfig.name}`;

    const mappedTo: string[] = [];

    if (!policy.to) {
      mappedTo.push("public");
    } else {
      if (policy.to && typeof policy.to === "string") {
        mappedTo.push(policy.to);
      } else if (policy.to && is(policy.to, PgRole)) {
        mappedTo.push(policy.to.name);
      } else if (policy.to && Array.isArray(policy.to)) {
        policy.to.forEach((it) => {
          if (typeof it === "string") {
            mappedTo.push(it);
          } else if (is(it, PgRole)) {
            mappedTo.push(it.name);
          }
        });
      }
    }

    // add separate policies object, that will be only responsible for policy creation
    // but we would need to track if a policy was enabled for a specific table or not
    // enable only if jsonStatements for enable rls was not already there + filter it
    if (
      result[tableKey]?.policies[policy.name] !== undefined ||
      policiesToReturn[policy.name] !== undefined
    ) {
      console.log(
        `\n${withStyle.errorWarning(
          `We\'ve found duplicated policy name across ${chalk.underline.blue(
            tableKey,
          )} table. Please rename one of the policies with ${chalk.underline.blue(
            policy.name,
          )} name`,
        )}`,
      );
      throw new Error(
        `We've found duplicated policy name across ${tableKey} table. Please rename one of the policies with ${policy.name} name`,
      );
    }

    const mappedPolicy = {
      name: policy.name,
      as: (policy.as?.toUpperCase() as Policy["as"]) ?? "PERMISSIVE",
      for: (policy.for?.toUpperCase() as Policy["for"]) ?? "ALL",
      to: mappedTo.sort(),
      using: is(policy.using, SQL)
        ? dialect.sqlToQuery(policy.using).sql
        : undefined,
      withCheck: is(policy.withCheck, SQL)
        ? dialect.sqlToQuery(policy.withCheck).sql
        : undefined,
    };

    if (result[tableKey]) {
      result[tableKey].policies[policy.name] = mappedPolicy;
    } else {
      policiesToReturn[policy.name] = {
        ...mappedPolicy,
        schema: tableConfig.schema ?? "public",
        on: `"${tableConfig.schema ?? "public"}"."${tableConfig.name}"`,
      };
    }
  }

  for (const sequence of sequences) {
    const name = sequence.seqName!;
    if (
      typeof sequencesToReturn[`${sequence.schema ?? "public"}.${name}`] ===
      "undefined"
    ) {
      const increment =
        stringFromIdentityProperty(sequence?.seqOptions?.increment) ?? "1";
      const minValue =
        stringFromIdentityProperty(sequence?.seqOptions?.minValue) ??
        (parseFloat(increment) < 0 ? "-9223372036854775808" : "1");
      const maxValue =
        stringFromIdentityProperty(sequence?.seqOptions?.maxValue) ??
        (parseFloat(increment) < 0 ? "-1" : "9223372036854775807");
      const startWith =
        stringFromIdentityProperty(sequence?.seqOptions?.startWith) ??
        (parseFloat(increment) < 0 ? maxValue : minValue);
      const cache =
        stringFromIdentityProperty(sequence?.seqOptions?.cache) ?? "1";

      sequencesToReturn[`${sequence.schema ?? "public"}.${name}`] = {
        name,
        schema: sequence.schema ?? "public",
        increment,
        startWith,
        minValue,
        maxValue,
        cache,
        cycle: sequence.seqOptions?.cycle ?? false,
      };
    } else {
      // duplicate seq error
    }
  }

  for (const role of roles) {
    if (!(role as any)._existing) {
      rolesToReturn[role.name] = {
        name: role.name,
        createDb:
          (role as any).createDb === undefined ? false : (role as any).createDb,
        createRole:
          (role as any).createRole === undefined
            ? false
            : (role as any).createRole,
        inherit:
          (role as any).inherit === undefined ? true : (role as any).inherit,
      };
    }
  }
  const combinedViews = [...views, ...matViews];
  for (const view of combinedViews) {
    let viewName;
    let schema;
    let query;
    let selectedFields;
    let isExisting;
    let withOption;
    let tablespace;
    let using;
    let withNoData;
    let materialized: boolean = false;

    if (is(view, PgView)) {
      ({
        name: viewName,
        schema,
        query,
        selectedFields,
        isExisting,
        with: withOption,
      } = getViewConfig(view));
    } else {
      ({
        name: viewName,
        schema,
        query,
        selectedFields,
        isExisting,
        with: withOption,
        tablespace,
        using,
        withNoData,
      } = getMaterializedViewConfig(view));

      materialized = true;
    }

    const viewSchema = schema ?? "public";

    const viewKey = `${viewSchema}.${viewName}`;

    const columnsObject: Record<string, Column> = {};
    const uniqueConstraintObject: Record<string, UniqueConstraint> = {};

    const existingView = resultViews[viewKey];
    if (typeof existingView !== "undefined") {
      console.log(
        `\n${withStyle.errorWarning(
          `We\'ve found duplicated view name across ${chalk.underline.blue(
            schema ?? "public",
          )} schema. Please rename your view`,
        )}`,
      );
      throw new Error(
        `We've found duplicated view name across ${schema ?? "public"} schema. Please rename your view`,
      );
    }

    for (const key in selectedFields) {
      if (is(selectedFields[key], PgColumn)) {
        const column = selectedFields[key];

        const notNull: boolean = column.notNull;
        const primaryKey: boolean = column.primary;
        const sqlTypeLowered = column.getSQLType().toLowerCase();

        const typeSchema = is(column, PgEnumColumn)
          ? column.enum.schema || "public"
          : undefined;
        const generated = column.generated;
        const identity = column.generatedIdentity;

        const increment =
          stringFromIdentityProperty(identity?.sequenceOptions?.increment) ??
          "1";
        const minValue =
          stringFromIdentityProperty(identity?.sequenceOptions?.minValue) ??
          (parseFloat(increment) < 0
            ? minRangeForIdentityBasedOn(column.columnType)
            : "1");
        const maxValue =
          stringFromIdentityProperty(identity?.sequenceOptions?.maxValue) ??
          (parseFloat(increment) < 0
            ? "-1"
            : maxRangeForIdentityBasedOn(column.getSQLType()));
        const startWith =
          stringFromIdentityProperty(identity?.sequenceOptions?.startWith) ??
          (parseFloat(increment) < 0 ? maxValue : minValue);
        const cache =
          stringFromIdentityProperty(identity?.sequenceOptions?.cache) ?? "1";

        /* lab extension */
        const enumValues = column.enumValues;
        const defaultFn = column.defaultFn?.toString();
        const onUpdateFn = column.onUpdateFn?.toString();
        const description = view[DrizzleLab]?.explain?.columns?.[column.name];

        const columnToSet: Column = {
          name: column.name,
          type: column.getSQLType(),
          typeSchema: typeSchema,
          primaryKey,
          notNull,
          generated: generated
            ? {
                as: is(generated.as, SQL)
                  ? dialect.sqlToQuery(generated.as as SQL).sql
                  : typeof generated.as === "function"
                    ? dialect.sqlToQuery(generated.as() as SQL).sql
                    : (generated.as as any),
                type: "stored",
              }
            : undefined,
          identity: identity
            ? {
                type: identity.type,
                name: identity.sequenceName ?? `${viewName}_${column.name}_seq`,
                schema: schema ?? "public",
                increment,
                startWith,
                minValue,
                maxValue,
                cache,
                cycle: identity?.sequenceOptions?.cycle ?? false,
              }
            : undefined,
          /* lab extension */
          enumValues,
          defaultFn,
          onUpdateFn,
          description,
        };

        if (column.isUnique) {
          const existingUnique = uniqueConstraintObject[column.uniqueName!];
          if (typeof existingUnique !== "undefined") {
            console.log(
              `\n${withStyle.errorWarning(
                `We\'ve found duplicated unique constraint names in ${chalk.underline.blue(viewName)} table. 
          The unique constraint ${chalk.underline.blue(column.uniqueName)} on the ${chalk.underline.blue(
            column.name,
          )} column is conflicting with a unique constraint name already defined for ${chalk.underline.blue(
            existingUnique.columns.join(","),
          )} columns\n`,
              )}`,
            );
            throw new Error(
              `We've found duplicated unique constraint names in ${viewName} table. 
          The unique constraint ${column.uniqueName} on the ${column.name} column is conflicting with a unique constraint name already defined for ${existingUnique.columns.join(
            ",",
          )} columns`,
            );
          }
          uniqueConstraintObject[column.uniqueName!] = {
            name: column.uniqueName!,
            nullsNotDistinct: column.uniqueType === "not distinct",
            columns: [columnToSet.name],
          };
        }

        if (column.default !== undefined) {
          if (is(column.default, SQL)) {
            columnToSet.default = sqlToStr(column.default, casing);
          } else {
            if (typeof column.default === "string") {
              columnToSet.default = `'${escapeSingleQuotes(column.default)}'`;
            } else {
              if (sqlTypeLowered === "jsonb" || sqlTypeLowered === "json") {
                columnToSet.default = `'${JSON.stringify(column.default)}'::${sqlTypeLowered}`;
              } else if (column.default instanceof Date) {
                if (sqlTypeLowered === "date") {
                  columnToSet.default = `'${column.default.toISOString().split("T")[0]}'`;
                } else if (sqlTypeLowered === "timestamp") {
                  columnToSet.default = `'${column.default.toISOString().replace("T", " ").slice(0, 23)}'`;
                } else {
                  columnToSet.default = `'${column.default.toISOString()}'`;
                }
              } else if (
                isPgArrayType(sqlTypeLowered) &&
                Array.isArray(column.default)
              ) {
                columnToSet.default = `'${buildArrayString(column.default, sqlTypeLowered)}'`;
              } else {
                // Should do for all types
                // columnToSet.default = `'${column.default}'::${sqlTypeLowered}`;
                columnToSet.default = column.default;
              }
            }
          }
        }
        columnsObject[column.name] = columnToSet;
      }
    }

    /* lab extension */
    const description = view[DrizzleLab]?.explain?.description;

    resultViews[viewKey] = {
      columns: columnsObject,
      definition: isExisting ? undefined : dialect.sqlToQuery(query!).sql,
      name: viewName,
      schema: viewSchema,
      isExisting,
      with: withOption,
      withNoData,
      materialized,
      tablespace,
      using,
      /* lab extension */
      description,
    };
  }

  const enumsToReturn: Record<string, Enum> = enums.reduce<{
    [key: string]: Enum;
  }>((map, obj) => {
    const enumSchema = obj.schema || "public";
    const key = `${enumSchema}.${obj.enumName}`;
    map[key] = {
      name: obj.enumName,
      schema: enumSchema,
      values: obj.enumValues,
    };
    return map;
  }, {});

  const schemasObject = Object.fromEntries(
    schemas
      .filter((it) => {
        if (schemaFilter) {
          return (
            schemaFilter.includes(it.schemaName) && it.schemaName !== "public"
          );
        } else {
          return it.schemaName !== "public";
        }
      })
      .map((it) => [it.schemaName, it.schemaName]),
  );

  /* lab extension */
  const provider =
    entities?.roles && typeof entities.roles === "object"
      ? entities.roles.provider
      : undefined;

  return {
    version: "7",
    dialect: "postgresql",
    tables: result,
    enums: enumsToReturn,
    schemas: schemasObject,
    sequences: sequencesToReturn,
    roles: rolesToReturn,
    policies: policiesToReturn,
    views: resultViews,
    _meta: {
      schemas: {},
      tables: {},
      columns: {},
    },
    /* lab extension */
    provider,
    projectId,
  };
}

/**
 * Convert the schema SQL dump to a Drizzle snapshot
 *
 * **It requires `@electric-sql/pglite` and `@electric-sql/pglite/vector` to be installed**
 *
 * @param sqlDump - SQL dump
 * @returns Drizzle snapshot
 */
export async function sqlToSnapshot(sqlDump: string) {
  const [{ PGlite }, { vector }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("@electric-sql/pglite/vector"),
  ]).catch(() => {
    throw new Error(
      "Please install @electric-sql/pglite and @electric-sql/pglite/vector to use this feature",
    );
  });

  const client = await PGlite.create({
    extensions: { vector },
  });

  const statements = splitSqlStatements(sqlDump);
  for (const statement of statements) {
    await client.query(statement);
  }

  // Extract schemas from the SQL dump
  const schemaRegex = /CREATE SCHEMA (?:IF NOT EXISTS )?"?(\w+)"?/g;
  const schemas = [
    "public",
    ...new Set(Array.from(sqlDump.matchAll(schemaRegex), (m) => m[1])),
  ];

  return importFromDatabase(
    {
      query: async (sql, params) => {
        const res = await client.query(sql, params);
        return res.rows as any;
      },
    },
    schemas,
    {
      roles: {
        provider: "pglite",
      },
    },
  );
}
