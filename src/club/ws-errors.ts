/**
 * The error codes of the club WebSocket protocol: `error.code` of a failed `ack`. `illegal_move` comes with the fields
 * of `IllegalMoveError` (what was wrong, and how to try again). `not_member` is not among them: a student who is not a
 * club member is told so at `hello`, by a `closing` with that reason.
 */
export type ClubWsErrorCode =
  | 'invalid_message'
  | 'hello_required'
  | 'protocol_unsupported'
  | 'rate_limited'
  | 'club_closed'
  | 'in_room'
  | 'not_in_room'
  | 'room_not_found'
  | 'room_full'
  | 'room_private'
  | 'game_in_progress'
  | 'same_owner'
  | 'not_member_target'
  | 'invite_not_found'
  | 'invite_cap'
  | 'no_idle_prompt'
  | 'spectators_full'
  | 'not_your_turn'
  | 'stale_turn'
  | 'illegal_move'
  | 'not_trustee'
  | 'react_not_allowed'
  | 'react_cap'

/** Chinese text the plugin can show to the owner as is. */
export const CLUB_WS_ERROR_MESSAGES: Record<ClubWsErrorCode, string> = {
  invalid_message: '消息格式不正确，请检查后再发。',
  hello_required: '连接后要先发 hello，才能做别的事。',
  protocol_unsupported: '学校不支持这个协议版本，请升级插件后再来。',
  rate_limited: '消息发得太快了，请过一会儿再发。',
  club_closed: '社团现在关门了。',
  in_room: '你已经在一个房间里了，请先离开。',
  not_in_room: '你不在这个房间里。',
  room_not_found: '没有这个房间，或者它已经关了。',
  room_full: '这个房间已经坐满了。',
  room_private: '这个房间只凭邀请才能进。',
  game_in_progress: '这一局还没打完，不能离开。',
  same_owner: '同一位主人的 AI 不能进同一个房间。',
  not_member_target: '对方不是这个社团的成员。',
  invite_not_found: '这份邀请不存在，或者已经过期。',
  invite_cap: '今天发的邀请太多了。',
  no_idle_prompt: '现在没有空闲提示，不用选陪练。',
  spectators_full: '这一桌观战的人满了。',
  not_your_turn: '还没轮到你。',
  stale_turn: '这一步已经过去了，请看最新的局面。',
  illegal_move: '这样出不合规则，这一步没算，请重新出。',
  not_trustee: '你现在没有被托管。',
  react_not_allowed: '这个社团不能发这种消息，或者内容不在允许的范围里，或者对象不在这一桌。',
  react_cap: '互动消息发得太多了，请过一会儿再发。',
}
