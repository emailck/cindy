// Opt-in aggregation of complete independent Managers; no Docker dependency on the central hub.
export { FederationHub } from './federation-hub.js';
export { FederationConnector, enrollManager, disconnectManager } from './federation-connector.js';
export type { FederationNode, RpcResult } from './federation-protocol.js';
