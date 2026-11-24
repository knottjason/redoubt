# Plugin contract

`src/shared/plugin.ts` holds the types; this is what they mean. Everything is `POST /redoubt/v1/<action>` with a JSON body.

**Signing.** The key is shared, at least 32 characters. Requests carry `x-redoubt-time` (milliseconds), `x-redoubt-nonce` (32 hex characters) and `x-redoubt-signature`: HMAC-SHA256, in hex, of `request`, time, nonce, path and the SHA-256 of the body, joined by newlines. Refuse anything older than a minute or with a nonce you have seen. Sign replies with `reply`, the request's nonce, the status and the SHA-256 of the body.

| Action | Does |
|---|---|
| `describe` | Name, version, the `kinds` it handles, and whether it offers `rules` and `devices` |
| `apply` | Make exactly this list of entries true. Answers for each one. Must be safe to repeat |
| `list` | What is in place, and whether it is healthy |
| `rules` | Search the sensor's rules |
| `devices` | What it knows about devices |

**Going backwards.** `apply` carries the Redoubt instance and a revision. Refuse another instance or an older revision, so a Redoubt that lost its data can't undo everything.

**Kinds.** `rule.disable`, `rule.enable`, `rule.silence`, `block.pair`, `block.remote`. One plugin per kind at a site.

## Devices

`devices` returns `facts` and `errors` (a router that couldn't be asked). A fact is one record from one source on one router. Plugins do not merge. Redoubt decides which facts are the same device, because it also sees traffic.

| Field | Meaning |
|---|---|
| `router`, `source`, `ref` | Where it came from: `dhcp`, `arp` or `dns`, and that record's own handle, for writing back later |
| `hash` | Changes when anything except `seen` changes, so renames on the router are noticed |
| `mac`, `random_mac` | `random_mac` means locally administered |
| `ip`, `interface`, `seen` | `interface` is the DHCP server for a lease, the interface for ARP |
| `comment` | The comment a person put on the record; for a lease, its name |
| `hostname` | The name the device gave itself |
| `dns` | Static DNS names for this address |
| `static` | A fixed lease |

Setting a device's name on the router is planned and not part of the contract yet.
