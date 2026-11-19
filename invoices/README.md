# Sample invoices

`npm run brain` reads every file in `inbox/`. The four samples tell the demo story:

| File | Vendor | Amount | What Custos does |
|---|---|---|---|
| `01-nimbus-INV-1042.md` | Nimbus Hosting (allowlisted) | 120 fUSD | Pays it inside the mandate |
| `02-lumen-INV-88.md` | Lumen Design Studio (allowlisted) | 350 fUSD | Pays it inside the mandate |
| `03-nimbus-INV-2210.md` | "Nimbus Hosting", new address | 4,800 fUSD | Poisoned: changed bank details, urgency and a hidden prompt injection in an HTML comment. The Brain flags it; the Keeper routes it to the owner; the vault would refuse the address anyway |
| `04-atlas-INV-5077.md` | Atlas Legal LLP (new vendor) | 600 fUSD | Not on the allowlist and over the cap: goes to the owner for an ML-DSA-87 approval |

Drop your own Markdown or plain-text invoices here. A processed invoice is remembered in `data/brain-state.json`; delete that file to process the inbox again.
