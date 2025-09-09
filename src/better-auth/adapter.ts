import { createAdapter, type AdapterDebugLogs } from "better-auth/adapters";
import { db, type AppDatabase } from "@/db/index";
import type { Database } from "kysely";

interface CustomAdapterConfig {
  /**
   * Helps you debug issues with the adapter.
   */
  debugLogs?: AdapterDebugLogs;
  /**
   * If the table names in the schema are plural.
   */
  usePlural?: boolean;
}

export const rwsdkAdapter = (config: CustomAdapterConfig = {}) =>
  createAdapter({
    config: {
      adapterId: "rwsdk-adapter",
      adapterName: "RWSDK Database Adapter",
      usePlural: config.usePlural ?? false,
      debugLogs: config.debugLogs ?? false,
      supportsJSON: false, // SQLite doesn't natively support JSON
      supportsDates: false, // We store dates as text
      supportsBooleans: true,
      supportsNumericIds: false, // We use text IDs
    },
    adapter: ({ debugLog }) => {
      return {
        async create({ model, data, select }) {
          debugLog && debugLog("create", { model, data, select });
          
          try {
            const result = await db.insertInto(model as any)
              .values(data)
              .returningAll()
              .executeTakeFirstOrThrow();
            
            return result;
          } catch (error) {
            debugLog && debugLog("create error", { error });
            throw error;
          }
        },

        async update({ model, where, update }) {
          debugLog && debugLog("update", { model, where, update });
          
          try {
            let query = db.updateTable(model as any).set(update);
            
            // Apply where conditions
            for (const [key, value] of Object.entries(where)) {
              query = query.where(key as any, "=", value);
            }
            
            const result = await query.returningAll().executeTakeFirstOrThrow();
            return result;
          } catch (error) {
            debugLog && debugLog("update error", { error });
            throw error;
          }
        },

        async updateMany({ model, where, update }) {
          debugLog && debugLog("updateMany", { model, where, update });
          
          try {
            let query = db.updateTable(model as any).set(update);
            
            // Apply where conditions
            for (const [key, value] of Object.entries(where)) {
              query = query.where(key as any, "=", value);
            }
            
            const result = await query.execute();
            return result.length;
          } catch (error) {
            debugLog && debugLog("updateMany error", { error });
            throw error;
          }
        },

        async delete({ model, where }) {
          debugLog && debugLog("delete", { model, where });
          
          try {
            let query = db.deleteFrom(model as any);
            
            // Apply where conditions
            for (const [key, value] of Object.entries(where)) {
              query = query.where(key as any, "=", value);
            }
            
            await query.execute();
          } catch (error) {
            debugLog && debugLog("delete error", { error });
            throw error;
          }
        },

        async deleteMany({ model, where }) {
          debugLog && debugLog("deleteMany", { model, where });
          
          try {
            let query = db.deleteFrom(model as any);
            
            // Apply where conditions
            for (const [key, value] of Object.entries(where)) {
              query = query.where(key as any, "=", value);
            }
            
            const result = await query.execute();
            return result.length;
          } catch (error) {
            debugLog && debugLog("deleteMany error", { error });
            throw error;
          }
        },

        async findOne({ model, where, select }) {
          debugLog && debugLog("findOne", { model, where, select });
          
          try {
            let query = db.selectFrom(model as any);
            
            // Apply select if provided
            if (select && select.length > 0) {
              query = query.select(select as any);
            } else {
              query = query.selectAll();
            }
            
            // Apply where conditions
            for (const [key, value] of Object.entries(where)) {
              query = query.where(key as any, "=", value);
            }
            
            const result = await query.executeTakeFirst();
            return result || null;
          } catch (error) {
            debugLog && debugLog("findOne error", { error });
            throw error;
          }
        },

        async findMany({ model, where, limit, sortBy, offset }) {
          debugLog && debugLog("findMany", { model, where, limit, sortBy, offset });
          
          try {
            let query = db.selectFrom(model as any).selectAll();
            
            // Apply where conditions
            if (where) {
              for (const [key, value] of Object.entries(where)) {
                query = query.where(key as any, "=", value);
              }
            }
            
            // Apply sorting
            if (sortBy) {
              if (typeof sortBy === "string") {
                query = query.orderBy(sortBy as any);
              } else if (sortBy.field) {
                const direction = sortBy.direction === "desc" ? "desc" : "asc";
                query = query.orderBy(sortBy.field as any, direction);
              }
            }
            
            // Apply limit
            if (limit) {
              query = query.limit(limit);
            }
            
            // Apply offset
            if (offset) {
              query = query.offset(offset);
            }
            
            const result = await query.execute();
            return result;
          } catch (error) {
            debugLog && debugLog("findMany error", { error });
            throw error;
          }
        },

        async count({ model, where }) {
          debugLog && debugLog("count", { model, where });
          
          try {
            let query = db.selectFrom(model as any).select(db.fn.count("id").as("count"));
            
            // Apply where conditions
            if (where) {
              for (const [key, value] of Object.entries(where)) {
                query = query.where(key as any, "=", value);
              }
            }
            
            const result = await query.executeTakeFirstOrThrow();
            return Number(result.count);
          } catch (error) {
            debugLog && debugLog("count error", { error });
            throw error;
          }
        },

        options: config,
      };
    },
  });