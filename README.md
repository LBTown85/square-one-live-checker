# Square One LIVE Checker

This repository contains only the public source for Square One's legacy TikTok LIVE status checker. It is intentionally separate from ONEhub, the ONEhub mobile app, private databases, internal collectors, and staff tools.

The service reads the public username roster in `creators.json`, checks public TikTok LIVE status, and exposes a read-only JSON feed.

## Endpoints

- `GET /health` — service status and scan counts
- `GET /live.json` — the public LIVE feed
- `GET /refresh` — moves the existing roster to the front of the rolling scan queue
- `GET /source` — redirects to this source repository

The existing production domain and response shapes are maintained by the Railway service that deploys this repository.

## Run locally

Requires Node.js 20 or newer.

```sh
npm ci
npm start
```

## License

Copyright (c) Square One Media LLC.

This project is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). The complete terms are in [LICENSE](LICENSE).

This public repository satisfies the corresponding-source requirement for the hosted legacy checker. No ONEhub source code or private credentials belong in this repository.
