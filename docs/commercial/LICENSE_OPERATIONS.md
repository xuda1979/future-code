# Offline activation operations (seller)

This feature manages a **commercial entitlement**, not access to underlying model providers. Customers supply their own provider credentials. No signing private key should appear in Git, build artifacts, tickets or logs.

## One-time seller bootstrap

Run locally on an offline trusted administrative machine:

```sh
node tools/license-admin.mjs init --private PATH_TO_PRIVATE_KEY --trust PATH_TO_PUBLIC_TRUST
```

The issuer utility prompts for a secret passphrase and writes the **encrypted Ed25519 private key** with owner-only permissions. Store it offline with appropriate backups. It also writes a public JSON trust manifest. After verifying the public key and issuer ID, replace `keys/trusted-issuers.json` with the approved **public manifest only**, rebuild and ship the updated commercial client. Keep the signing private key entirely outside the repository and CI.

For a new paid or authorized customer, ask them to run `license request` and send the resulting installation ID to the seller. Issue the entitlement offline:

```sh
node tools/license-admin.mjs issue --private PATH_TO_PRIVATE_KEY --customer CUSTOMER_ID --installation INSTALLATION_ID --grant paid --days 30 --out PRIVATE_ACTIVATION_FILE
```

Use `--grant authorized` for approved non-paying licenses. Only approved operators should issue entitlements. Deliver activation files over a secure channel. Customer activates via `license activate --file`.

## Limitations and threats

The client validates the Ed25519 signature, issuer, installation binding, grant, feature and expiration offline. No private signing key is required by the client. Local clock rollback, modified binaries and patched source can defeat purely client-side controls. A centralized license service is needed for reliable revocation, seat control, cross-device policy and abuse management. Seller operations should be moved to a secured back office service before broad distribution.

Signing utility installation is not a substitute for vendor legal review, IP ownership clearance, third-party license audit, customer privacy controls, or secure deployment.
