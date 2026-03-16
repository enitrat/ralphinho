// Local adapters (the only reason this directory exists)
export { pushFindingsToLinear } from "./push-findings";
export { consumeTicket, markTicketInProgress, markTicketDone } from "./consume-tickets";
export type { PushFindingsResult, ConsumedTicket } from "./types";
