import { memorySql } from "@p-lens-relay/sql/testing"
import { prepare } from "../src/storage/schema"

/** A bucket's SQLite in memory, its tables made. */
export const bucketSql = () => memorySql(prepare)
