# Portable remote Agent host

This Node package contains the existing `maker:remote-agent:v1` execution host.
Desktop and headless clients use the same payload codecs, lifecycle, reverse
tunnels, guest isolation, provider-group relay and startup optimizations.
It does not import an application, Electron, a database or an authentication UI.

The embedding client supplies `RemoteAgentHostDeps` to `createRemoteAgentHost`:

- `isControllerAuthorized`, `captureOwner` and `isOwnerCurrent` bind requests
  and asynchronous work to the authenticated account and current device grant.
- `isAgentAvailable` reports installed harnesses; `startHosted` returns a native
  `AgentSessionHandle`. `hostedStartOptions(input)` preserves the existing
  maker-core options, including reverse execution and isolated application tools.
- `providerAccess` and the owner/guest route bindings enforce live provider and
  model grants. An embedding client must supply its actual authorization policy;
  the compatibility defaults are not a replacement for admission checks.
- `runsRoot` is an account-scoped runtime directory supplied by the embedding
  client. Shadow workspaces contain synchronized instruction assets, not the
  controller's project tree. Real file, shell and Cindy-tool operations travel
  back through the controller's existing executor.
- Optional sharing, provider-group, image, history, metering and policy hooks
  retain their existing contracts. Unsupported capabilities must be omitted or
  rejected by the embedding client rather than advertised as available.

Dispatch the already authenticated peer and raw request to
`host.handle(controller, request, signal)`. On account/grant changes use the
existing targeted abort methods. Await `host.dispose()` during shutdown; it
waits for native harness and shadow-workspace cleanup.

The public root exports the host factory, contracts, `hostedStartOptions` and
limits. Explicit subpath exports retain the Desktop compatibility entry points.
The original Desktop modules re-export these implementations, so callers and
existing behavioral tests exercise this package without parallel copies.

This extraction changes no protocol version, capability, authorization decision,
prompt, path projection, retry policy or persistence layout. CLI authentication,
device registration, provider selection and process packaging belong to the
embedding application.
