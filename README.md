# abasthan-gateway

Token-gated personal utility gateway deployed on an Abasthan free instance.

- `POST /run` — run a shell command on the instance, returns {code, stdout, stderr}
- `GET /fetch?url=` — fetch a URL from the instance's network, returns {status, finalUrl, contentType, body}
- `GET /` — health check, returns `ok`

All functional endpoints require the `x-gateway-token` header.
The token is set via the `GATEWAY_TOKEN` environment variable in the Abasthan dashboard — it is never stored in this repo.
