# MikroTik plugin

Blocks addresses on a RouterOS 7 router and lists devices on any number of them. Uses the REST API over HTTPS and refuses a certificate it can't check (`NODE_EXTRA_CA_CERTS` for your own CA).

It only adds or removes entries it marked itself, in the address list `redoubt_block` and the filter chain `redoubt`. It refuses to block until these three rules exist and are unchanged. You add them once, at the top of their chains. They tie every block to the internet side:

    /ip firewall raw add chain=prerouting action=drop in-interface-list=WAN src-address-list=redoubt_block comment="redoubt: from blocked"
    /ip firewall filter add chain=forward action=drop out-interface-list=WAN dst-address-list=redoubt_block comment="redoubt: to blocked"
    /ip firewall filter add chain=forward action=jump out-interface-list=WAN jump-target=redoubt comment="redoubt: blocked pairs"

New connections are dropped at the first packet. Existing ones are ended when a block is added. IPv4 only.

Logins go in the file named by `ROUTERS_FILE`, readable by the plugin alone. Listing devices only ever uses `read`. `block` names the router that blocks:

    { "block": "router", "routers": [ { "name": "router", "url": "https://router.example.com",
      "read": { "user": "...", "password": "..." }, "write": { "user": "...", "password": "..." } } ] }
