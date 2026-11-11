# Status worker (the outside sentinel)

A small Cloudflare Worker that checks the school from the outside, because a school that is down cannot report that it is down.

Every minute it:

- reads `GET /healthz` and `GET /healthz/class` (both must answer `200` within 10 seconds for the school to count as healthy) and `GET /v1/school-calendar` (its `maintenance` field);
- reads the registration service's `GET /healthz/mail`, which says whether mail is going out;
- decides the status (`ok`, `maintenance` or `down`) and mails the operator when it changes in a way that needs attention.

It also serves `GET /status.json` for plugins that cannot reach the school (see "The status file" in [`docs/api.md`](../../docs/api.md)). Every other path is a 404.

## What it mails

| Subject | When |
| --- | --- |
| 【机器人网校】连不上学校了 | The school has been unreachable for 5 minutes outside maintenance. Sent once. |
| 【机器人网校】学校已恢复 | The school answers again after that. Sent once. |
| 【机器人网校】验证码发不出去了 | `/healthz/mail` says mail is not going out. Sent when it breaks, and again every hour while it stays broken. |
| 【机器人网校】发信已恢复 | `/healthz/mail` says mail works again. Sent once. |

Maintenance (reported by the school, or switched on by hand) never causes a mail, and neither does a school that stops answering while it is in maintenance. A school that cannot be reached says nothing about mail, so the mail check is skipped then. A broken mail check does not change `status.json`. The mails say only what happened and when; they carry no student data.

## State in KV

| Key | Written by | Meaning |
| --- | --- | --- |
| `state` | the worker | The current status, as JSON. |
| `mail` | the worker | When mail started failing and when the operator was last told. |
| `pending` | the worker | Mails that could not be sent yet; retried every minute and cleared once sent. |
| `manual` | the operator | The value `maintenance` forces the status to maintenance. Delete the key to go back to automatic. |
| `note` | the operator | One sentence that replaces the generated message in `status.json`. Delete the key to remove it. |

The worker writes only when something changes (the free plan allows 1,000 KV writes a day).

## Deploying

You need a Cloudflare account, a domain on Cloudflare for the status host (for example `status.example.com`), and a mailbox of your own.

1. `npm ci` in this directory, then `npx wrangler login`.
2. Create the KV namespace: `npx wrangler kv namespace create STATE`, and keep the id it prints.
3. Copy `wrangler.example.toml` to `wrangler.toml` (git-ignored) and fill in the KV id, `SCHOOL_URL` (the school's public address), `ALERT_TO`, `ALERT_FROM` and the status host. Real values stay out of the repository.
4. In the Cloudflare dashboard, turn on Email Routing for the domain and verify the `ALERT_TO` address there; the Worker can only send to a verified address. `ALERT_FROM` must be an address on that domain.
5. `npx wrangler deploy`. This sets the every-minute trigger and puts the Worker on the status host.
6. Check `https://<status host>/status.json`. Right after the first deploy it answers 503 until the first run has finished (about a minute).

To switch maintenance on by hand: `npx wrangler kv key put manual maintenance --binding STATE --remote` (and `note` for a message); `npx wrangler kv key delete manual --binding STATE --remote` to end it. After you end it, the school has 5 minutes to answer before a mail goes out.

## Developing

```sh
npm run typecheck
npm test
npm run dev   # wrangler dev --test-scheduled; trigger a run with GET /__scheduled
```

The decisions are pure functions in `src/sentinel.ts` (`decide`, `decideMail`), tested in `test/sentinel.test.ts`; `src/index.ts` only reads KV, probes, and sends.
