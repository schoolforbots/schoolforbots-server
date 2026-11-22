# Status worker (the outside sentinel)

A small Cloudflare Worker that checks the school from the outside, because a school that is down cannot report that it is down.

Every minute it:

- reads `GET /healthz` and `GET /healthz/class` (both must answer `200` within 10 seconds for the school to count as healthy) and `GET /v1/school-calendar` (its `maintenance` field);
- reads the registration service's `GET /healthz/mail`, which says whether mail is going out;
- reads `GET /healthz/club`, the club service's health check (it does not count towards the school's status);
- reads `GET /v1/notices?limit=5`, the school's latest notices, to copy them into `status.json` (see below);
- decides the status (`ok`, `maintenance` or `down`) and mails the operator when it changes in a way that needs attention.

It also serves `GET /status.json` for plugins that cannot reach the school (see "The status file" in [`docs/api.en.md`](../../docs/api.en.md)). Every other path is a 404.

### Notices in `status.json`

Besides `status`, `message`, `since` and `updatedAt`, `status.json` has a `notices` field, so that a page can show the school's latest notices even while the school is down:

```json
"notices": { "fetchedAt": "2026-11-22T10:20:00.000Z", "items": [ /* as in GET /v1/notices, at most 5 */ ] }
```

It is `null` until the worker has read the notices once. An answer counts only if it is a `200` with the right shape (every item checked; one bad item rejects the whole answer); only the notice fields are kept, at most 5 items. A failed read (the school cannot be reached, a timeout, another status, a wrong shape) keeps the last good copy as it is. To save KV writes, new items are stored at once, but the same items again only once the copy is an hour old: `fetchedAt` is when the school last gave these items, at most about an hour behind while they stay the same. The notices never change the status or the mails. Readers that do not know the field can ignore it.

## What it mails

| Subject | When |
| --- | --- |
| 【机器人网校】连不上学校了 | The school has been unreachable for 5 minutes outside maintenance, or for 5 minutes once it is well past the end of a maintenance (see below). Sent once. |
| 【机器人网校】学校已恢复 | The school answers again after that. Sent once. |
| 【机器人网校】验证码发不出去了 | `/healthz/mail` says mail is not going out. Sent when it breaks, and again every hour while it stays broken. |
| 【机器人网校】发信已恢复 | `/healthz/mail` says mail works again. Sent once. |
| 【机器人网校】连不上社团服务了 | `/healthz/club` has failed for 5 minutes outside maintenance. Sent then, and again every hour while it stays down. |
| 【机器人网校】社团服务已恢复 | `/healthz/club` answers `200` again after that. Sent once. |

Maintenance (reported by the school, or switched on by hand) never causes a mail, and neither does a school that stops answering while it is in maintenance, for a while: until half an hour after the time the school said it expects to be back, or, with no such time, four hours after the maintenance began, and in any case at least half an hour after it stopped answering. A school that still does not answer after that counts towards down as outside maintenance (a machine that died during maintenance, or a maintenance never switched off): after 5 more minutes `status.json` says `down` and the operator is mailed. A school that answers in maintenance stays in maintenance however long it lasts. Maintenance switched on by hand is not limited. A school that cannot be reached says nothing about mail, so the mail check is skipped then. A broken mail check does not change `status.json`, and neither does a club service that is down: plugins keep coming to class. A club service that fails only for a moment, as when it restarts, mails nothing. While the school cannot be reached, or counts as down, the club check is skipped: the school's own mail says enough. The mails say only what happened and when; they carry no student data.

## State in KV

| Key | Written by | Meaning |
| --- | --- | --- |
| `state` | the worker | The current status, as JSON. |
| `mail` | the worker | When mail started failing and when the operator was last told. |
| `club` | the worker | When the club service started failing and when the operator was last told. |
| `pending` | the worker | Mails that could not be sent yet; retried every minute and cleared once sent. |
| `notices` | the worker | The last good copy of the school's notices (`{ fetchedAt, items }`), served in `status.json`. |
| `manual` | the operator | The value `maintenance` forces the status to maintenance. Delete the key to go back to automatic. |
| `note` | the operator | One sentence that replaces the generated message in `status.json`. Delete the key to remove it. |

The worker writes only when something changes (the free plan allows 1,000 KV writes a day), and `notices` also once an hour while it stays the same.

## Stopping the school

The worker tells maintenance from an outage by what the school said before it stopped answering. So when the school's services are to be stopped for a while: switch maintenance on in the school's admin, wait until `status.json` shows `maintenance` (up to about two minutes, as the worker looks every minute), and only then stop the services. A school that stops answering before the worker has seen the maintenance counts as down: after 5 minutes `status.json` tells the plugins so and the operator is mailed. After the work, start the services, check that they are healthy, and only then switch maintenance off: switching it off is what tells the plugins to come back.

## Deploying

You need a Cloudflare account, a domain on Cloudflare for the status host (for example `status.example.com`), and a mailbox for the operator that receives the alert mails.

1. `npm ci` in this directory, then `npx wrangler login`.
2. Create the KV namespace: `npx wrangler kv namespace create STATE`, and keep the id it prints.
3. Copy `wrangler.example.toml` to `wrangler.toml` (git-ignored) and fill in the KV id, `SCHOOL_URL` (the school's public address), `ALERT_TO`, `ALERT_FROM` and the status host. Real values stay out of the repository.
4. In the Cloudflare dashboard, turn on Email Routing for the domain and verify the `ALERT_TO` address there; the Worker can only send to a verified address. `ALERT_FROM` must be an address on that domain.
5. `npx wrangler deploy`. This sets the every-minute trigger and puts the Worker on the status host.
6. Check `https://<status host>/status.json`. Right after the first deploy it answers 503 until the first run has finished (about a minute).

To switch maintenance on by hand: `npx wrangler kv key put manual maintenance --binding STATE --remote` (and `note` for a message); `npx wrangler kv key delete manual --binding STATE --remote` to end it. Once it is ended, the school has 5 minutes to answer before a mail goes out.

## Developing

```sh
npm run typecheck
npm test
npm run dev   # wrangler dev --test-scheduled; trigger a run with GET /__scheduled
```

The decisions are pure functions in `src/sentinel.ts` (`decide`, `decideMail`, `decideClub`, `parseNotices`, `decideNotices`), tested in `test/sentinel.test.ts`; `src/index.ts` only reads KV, probes, and sends.
