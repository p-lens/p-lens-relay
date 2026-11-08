export { frontOf, type Front } from "./front"
export { informationOf } from "./information"
export { LABELS, routeOf, type Route } from "./routing"
export { bucketOf, HELD_IN_PROCESS, leave, receive, wake, type Bucket, type Holding, type Outgoing, type Waking } from "./session"
export { settingsErrorText, settingsOf, type Environment, type Settings, type SettingsError } from "./settings"
export { dueOf, prune } from "./storage/events"
export type { Carried } from "./storage/subscriptions"
export { ticketReaderOf } from "./ticket-reader"

/** How often a bucket held in a process takes out what has run out; a hibernating one is woken when something is due instead. */
export const PRUNING_SECONDS = 3_600
