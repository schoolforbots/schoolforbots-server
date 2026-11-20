# RLCard doudizhu move types

`doudizhu-types.json.gz` lists every doudizhu move known to [RLCard](https://github.com/datamllab/rlcard), with the
move types RLCard gives it, in our `MoveType` names. `tests/club/doudizhu/rlcard.test.ts` compares our `classify`
with it.

## Source

- File: `rlcard/games/doudizhu/jsondata.zip` of `datamllab/rlcard` at commit
  `d7d0a957baf4cc7225a50522adb0164bf130a9d0`:
  <https://github.com/datamllab/rlcard/raw/d7d0a957baf4cc7225a50522adb0164bf130a9d0/rlcard/games/doudizhu/jsondata.zip>
- Size 225279 bytes, sha256 `10882cea3c35cd15ec63044abec16091403d4d80ff98a85b6078a5548d2305fd`.
- License: MIT, Copyright (c) 2019 DATA Lab at Texas A&M University. The full text is in [`LICENSE`](LICENSE) (the
  repository's `LICENSE.md` at the same commit). The zip itself is not kept here, only the data derived from it.

The zip holds `jsondata/card_type.json` (cards → move types), `jsondata/type_card.json` (move type → strength →
cards) and `jsondata/action_space.txt` (every move, and `pass`). The fixture is made from `card_type.json`; the script
checks that the other two files list the same moves with the same types and strengths. Each move has exactly one
RLCard type.

## Format

A gzipped JSON array with one move per line, sorted by length and then rank by rank:

```
["<cards>", [["<MoveType>", "<RLCard type>", <strength>], ...]]
```

for example `["33344456",[["plane_solo","trio_solo_chain_2",1]]]`.

- Cards are written in RLCard's characters, low to high: `3`–`9`, `T` (10), `J`, `Q`, `K`, `A`, `2`, `B` (black
  joker, 小王), `R` (red joker, 大王).
- The RLCard type is its name with the chain length (`trio_solo_chain_2`).
- The strength is RLCard's number for the move within that type: higher is stronger, but it does not always start
  at 0. `card_type.json` gives it as a string; here it is a number.
- Each move has exactly one reading. 27471 moves.

The current file is 86729 bytes, sha256 `b9dcad3131a3ee32d051407413c857edf45d039cd071d95787c84f9b47e84723`.

## Move type names

RLCard's chains carry their length in the name (`solo_chain_5`, `trio_solo_chain_2`, …); the length is dropped.

| RLCard | `MoveType` |
|---|---|
| `solo` | `single` |
| `pair` | `pair` |
| `trio` | `trio` |
| `trio_solo` | `trio_solo` |
| `trio_pair` | `trio_pair` |
| `solo_chain_5` … `solo_chain_12` | `straight` |
| `pair_chain_3` … `pair_chain_10` | `pair_straight` |
| `trio_chain_2` … `trio_chain_6` | `trio_straight` |
| `trio_solo_chain_2` … `trio_solo_chain_5` | `plane_solo` |
| `trio_pair_chain_2` … `trio_pair_chain_4` | `plane_pair` |
| `four_two_solo` | `four_two_solo` |
| `four_two_pair` | `four_two_pair` |
| `bomb` | `bomb` |
| `rocket` | `rocket` |

## Regenerating

Download the zip above, then:

```
npx tsx scripts/gen-rlcard-fixture.ts path/to/jsondata.zip
```

The script only reads the zip as data and refuses any other file (it checks the sha256). The output is deterministic:
the same lines in the same order, and a gzip header with no time stamp and an "unknown" OS byte. The compressed bytes
come from Node's zlib at level 9; a different zlib build could compress differently, but the content is the same.
