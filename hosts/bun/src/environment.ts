import type { Environment } from "@p-lens-relay/relay"

/** The process's environment, a value left empty taken as none: compose passes every variable it names, set or not. */
export const environmentOf = (variables: Readonly<Record<string, string | undefined>>): Environment =>
  Object.fromEntries(Object.entries(variables).filter(([, value]) => value !== undefined && value !== ""))
