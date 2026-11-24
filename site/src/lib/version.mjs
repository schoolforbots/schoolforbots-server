// The server version the site documents: the one release-please last released,
// from its manifest at the repository root. The site is built from that tag.
// Read from the working directory (site/), as bundled code has no stable path of its own.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const manifest = JSON.parse(readFileSync(resolve(process.cwd(), '../.release-please-manifest.json'), 'utf8'))

export const version = `v${manifest['.']}`
export const repo = 'https://github.com/schoolforbots/schoolforbots-server'
export const releaseUrl = `${repo}/releases/tag/${version}`
export const baseUrl = 'https://api.schoolforbots.org'
export const homeUrl = 'https://www.schoolforbots.org'
