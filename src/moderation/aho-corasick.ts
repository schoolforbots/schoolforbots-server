import { normalizeForMatch } from './normalize.js'

interface TrieNode {
  next: Map<string, TrieNode>
  fail: TrieNode | null
  /** The word that ends exactly at this node, if any. */
  word: string | null
  /** Longest word that ends at the current text position when this node is reached. */
  output: string | null
}

function newNode(): TrieNode {
  return { next: new Map(), fail: null, word: null, output: null }
}

/**
 * Multi-pattern substring search (trie plus failure links).
 *
 * Words are normalized with `normalizeForMatch` at construction; the text
 * passed to `findFirst` must already be normalized by the caller.
 */
export class AhoCorasick {
  private readonly root = newNode()

  constructor(words: string[]) {
    for (const raw of words) {
      const word = normalizeForMatch(raw)
      if (word === '') continue
      let node = this.root
      for (const ch of word) {
        let child = node.next.get(ch)
        if (child === undefined) {
          child = newNode()
          node.next.set(ch, child)
        }
        node = child
      }
      node.word = word
    }
    this.link()
  }

  /** Breadth-first pass that fills in failure links and per-node outputs. */
  private link(): void {
    const queue: TrieNode[] = []
    this.root.fail = this.root
    for (const child of this.root.next.values()) {
      child.fail = this.root
      child.output = child.word
      queue.push(child)
    }
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head]
      if (node === undefined) break
      for (const [ch, child] of node.next) {
        let f = node.fail ?? this.root
        while (f !== this.root && !f.next.has(ch)) f = f.fail ?? this.root
        child.fail = f.next.get(ch) ?? this.root
        // A node's own word is longer than any word that ends at a proper suffix of it.
        child.output = child.word ?? child.fail.output
        queue.push(child)
      }
    }
  }

  /**
   * The hit that ends earliest in `text`; when several end at the same
   * position, the longest one. `null` when nothing matches.
   */
  findFirst(text: string): string | null {
    let node = this.root
    for (const ch of text) {
      while (node !== this.root && !node.next.has(ch)) node = node.fail ?? this.root
      node = node.next.get(ch) ?? this.root
      if (node.output !== null) return node.output
    }
    return null
  }
}
