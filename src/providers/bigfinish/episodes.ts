import { load } from 'cheerio'
import type { CheerioAPI } from 'cheerio'
import { normalizeText } from '../../metadata/identity'

export interface BigFinishEpisode {
  number: string
  title: string
  writers: string[]
  adapters: string[]
  narrators: string[]
  synopsisHtml: string
}

type EpisodeHeading = Omit<BigFinishEpisode, 'synopsisHtml'>

// "2.1 Title", "2.3.2 Title", "1. Title", "Episode 4 Title" or "Part 1: Title"
const HEADING_PATTERN = /^(?:(?:Episode|Part)\s+(\d{1,2})(?=[\s:])|(\d+(?:\.\d+)+|\d{1,2}(?=\.)))[.:]?\s+(.+)$/
// Credits use a lowercase "by", which keeps titles such as "By Hook or By Crook" intact
const CREDIT_SEPARATOR =
  /(?:,|\s+and)?\s+([Aa]dapted|[Nn]arrated|[Rr]ead|(?:[Ff]rom|[Bb]ased on)\s+(?:an?\s+|the\s+)?(?:original\s+)?(?:story(?:line)?|idea|novel|script|play|serial|outline|treatment|characters?))?\s*by\s+/
const CREDIT_GLUE = /^(?:\s|[,&'‘’"“”]|and|by|adapted|narrated|read)*$/i
const CONTRIBUTORS_MARKER = '<!--contributors-->'
const EPISODE_MARKER = /<!--episode:(\d+)-->/
const BLOCK_SELECTOR = 'p, ul, ol, li, div, blockquote'
const VOLUME_TOKEN = /\s+(Series\s+|Volume\s+|Vol\.?\s*|Part\s+)?0*(\d{1,3})[a-z]?(?=\s|$)/gi

// Box sets list their stories only as "<number> <title> by <credits>" heading lines inside the description
export function parseEpisodes(html: string | null | undefined): BigFinishEpisode[] {
  if (!html) return []

  const $ = load(html, null, false)
  $('hr, p')
    .filter((_, element) => $(element).is('hr') || $(element).text().trim() === 'Contributors')
    .first()
    .replaceWith(CONTRIBUTORS_MARKER)

  // Headings become indexed markers so each synopsis is simply the HTML between two of them
  const headings = markHeadings($)
  const [body] = $.html().split(CONTRIBUTORS_MARKER)
  const parts = body.split(EPISODE_MARKER)

  const episodes: BigFinishEpisode[] = []
  for (let index = 1; index < parts.length; index += 2) {
    episodes.push({ ...headings[Number(parts[index])], synopsisHtml: synopsisHtml(parts[index + 1]) })
  }
  return episodes
}

export function parseHeading(text: string, requireCredits = true): EpisodeHeading | null {
  // "8. 1 Title" is a typo for 8.1
  const line = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(\d+)\. (\d{1,2}) /, '$1.$2 ')
  const match = HEADING_PATTERN.exec(line)
  if (!match) return null

  const [, labelled, numbered, rest] = match
  const number = labelled || numbered
  const [title, ...credits] = rest.replace(/[()]/g, ' ').split(CREDIT_SEPARATOR)
  const heading: EpisodeHeading = {
    number,
    title: title.replace(/(?:[\s,:;–-]|\s+by)+$/, ''),
    writers: [],
    adapters: [],
    narrators: []
  }

  for (let index = 0; index < credits.length; index += 2) {
    const role = (credits[index] || '').toLowerCase()
    const names = splitNames(credits[index + 1] || '')
    if (role === 'adapted') heading.adapters.push(...names)
    else if (role === 'narrated' || role === 'read') heading.narrators.push(...names)
    else heading.writers.push(...names)
  }

  const credited = heading.writers.length > 0 || heading.adapters.length > 0
  // Only a dotted number or an Episode/Part label makes an uncredited bold line recognisable as a heading
  if (!heading.title || (!credited && (requireCredits || !(labelled || number.includes('.'))))) return null
  return heading
}

export function splitNames(value: string): string[] {
  return value
    .split(/\s*,\s*|\s+and\s+|\s+&\s+/i)
    .map((name) => name.trim())
    .filter(Boolean)
}

// "'X' and the Daleks" equals "X & the Daleks", "L.E.G.E.N.D" equals "LEGEND", and "Day of the Master Parts 1-2"
// equals "Day of the Master"; a single "Part 1" still tells parts apart
export function matchKey(value: string): string {
  return normalizeText(
    value
      .replace(/['‘’`´]/g, '')
      .replace(/(?<=\b\p{L})\.(?=\p{L}\b)/gu, '')
      .replace(/\s+Parts?\s+\d+\s*(?:-|–|&|and)\s*\d+\s*$/i, '')
      .replace(/&/g, ' and ')
  )
}

// The series an episode number counts in: the title part numbered like the episode's volume ("Dark Eyes" for 2.1 in
// "Doctor Who: Dark Eyes 2", "Gallifrey: Time War" for 1.1 in "Gallifrey: Time War 1"), otherwise the range, which
// numbers box sets such as Bernice Summerfield 13.1. Single-level numbers count within the box set itself.
export function episodeSeries(boxSetTitle: string, range: string | undefined, number: string): string | undefined {
  const segments = boxSetTitle
    .replace(/\s*\([^)]*\)\s*$/, '')
    .split(':')
    .map((segment) => segment.trim())
    .filter(Boolean)
  const doctorWho = segments.length > 1 && segments[0] === 'Doctor Who'
  if (doctorWho) segments.shift()
  // A leading "Blake's 7" names the range rather than a volume of it
  const franchise = !doctorWho && segments.length > 1
  if (!number.includes('.')) return segments.join(': ') || range

  const volume = Number(number.split('.')[0])
  for (let index = segments.length - 1; index >= 0; index--) {
    for (const match of segments[index].matchAll(VOLUME_TOKEN)) {
      if (Number(match[2]) !== volume || (index === 0 && franchise && !match[1])) continue

      const arc = segments[index].slice(0, match.index).trim()
      return [...segments.slice(0, index), arc].filter(Boolean).join(': ') || range
    }
  }
  return range
}

// A heading is a line (a block's content up to a <br>) that is bold, possibly split across several bold
// elements, or an unbolded first line of a block that a <br> separates from its synopsis
function markHeadings($: CheerioAPI): EpisodeHeading[] {
  const headings: EpisodeHeading[] = []
  const containers = [$.root()[0], ...$(BLOCK_SELECTOR).toArray()]

  for (const container of containers) {
    const nodes = $(container).contents().toArray()
    const lines: { nodes: typeof nodes; broken: boolean }[] = [{ nodes: [], broken: false }]
    for (const node of nodes) {
      if ($(node).is(`br, ${BLOCK_SELECTOR}`)) {
        lines[lines.length - 1].broken = $(node).is('br')
        lines.push({ nodes: [], broken: false })
      } else {
        lines[lines.length - 1].nodes.push(node)
      }
    }

    const filled = lines.filter((line) => line.nodes.some((node) => $(node).text().trim()))
    for (const [index, line] of filled.entries()) {
      const words = line.nodes.filter((node) => $(node).text().trim())
      const bold = words.map((node) => {
        const text = $(node).text().trim()
        return $(node).is('strong, b') || $(node).find('strong, b').text().trim() === text
      })
      const text = line.nodes.map((node) => $(node).text()).join('')
      const boldLine = bold.every((isBold, word) => isBold || CREDIT_GLUE.test($(words[word]).text()))

      let heading: EpisodeHeading | null = null
      let replaced = line.nodes
      // Bold lines may be uncredited; an unbolded line is only a heading when it names its writer
      if (bold[0] && boldLine) heading = parseHeading(text, false)
      if (bold[0] && !heading) {
        heading = parseHeading($(words[0]).text(), false)
        replaced = [words[0]]
      }
      if (!bold[0] && index === 0 && line.broken) heading = parseHeading(text)
      if (!heading) continue

      // before() ignores text nodes, so the first node is replaced instead
      $(replaced[0]).replaceWith(`<!--episode:${headings.length}-->`)
      for (const node of replaced.slice(1)) $(node).remove()
      headings.push(heading)
    }
  }

  return headings
}

function synopsisHtml(fragment: string): string {
  const $ = load(fragment, null, false)
  const blocks: string[] = []
  let inline = ''

  for (const node of $.root().contents().toArray()) {
    if (!$(node).is(BLOCK_SELECTOR)) {
      inline += $.html(node)
      continue
    }

    blocks.push(paragraph(inline))
    if ($(node).text().trim()) blocks.push($.html(node))
    inline = ''
  }
  blocks.push(paragraph(inline))

  return blocks.join('')
}

function paragraph(inline: string): string {
  const content = inline.replace(/^(?:\s|<br\s*\/?>)+|(?:\s|<br\s*\/?>)+$/gi, '')
  return content ? `<p>${content}</p>` : ''
}
