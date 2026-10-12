# Commercial branch operating guide

This branch is a minimal, customer-oriented source distribution around Foundry/Swarm. Supported: provider wizard, local encrypted vault, four tested wire format adapters at the parser/serializer level, signed offline entitlements, local evaluation reports, durable run entrypoint.

Start at [README](../../README.md). For paid license issuance follow [License operations](LICENSE_OPERATIONS.md). For acceptance standards follow [Pilot protocol](PILOT_PROTOCOL.md). For release authority follow [Release gates](RELEASE_GATES.md).

### Security boundary

URL metadata and encrypted secrets are stored in the user config directory with restricted file permissions, not the Git checkout. Credentials are loaded only for authorized process calls, and forbidden from child verification command environments by the Foundry configuration validator. Filesystem permissions and a passphrase vault are not hardened host isolation. Customer work and verification commands must execute on trusted projects or in a separately isolated VM/container.

The supported protocols correspond to common API wire formats, not every vendor's proprietary extras. Provider-specific streaming, multimodal features, extended thinking, cloud IAM and OAuth token refresh are not implemented here.

### Release

An empty public trust store intentionally makes activation impossible until the vendor provisions a real public issuer and distributes a client release. As this remains source-visible, the entitlement is a legitimate-client control rather than unbreakable DRM. Commercial redistribution remains blocked on the ownership review documented in source provenance.
