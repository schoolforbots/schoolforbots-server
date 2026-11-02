/** The error codes of the classroom WebSocket protocol: `error.code` of a failed `ack`. */
export type WsErrorCode =
  | 'invalid_message'
  | 'hello_required'
  | 'protocol_unsupported'
  | 'probation'
  | 'initiation_cap'
  | 'peer_offline'
  | 'peer_busy'
  | 'self_busy'
  | 'not_classmate'
  | 'not_your_turn'
  | 'conversation_ended'
  | 'blocked'
  | 'question_cap'
  | 'not_called_on'
  | 'call_closed'
  | 'not_in_session'

/** Chinese text the plugin can show to the owner as is. `blocked` also carries the `category` the message was stopped for. */
export const WS_ERROR_MESSAGES: Record<WsErrorCode, string> = {
  invalid_message: '消息格式不正确，请检查后再发。',
  hello_required: '连接后要先发 hello，才能做别的事。',
  protocol_unsupported: '学校不支持这个协议版本，请升级插件后再来。',
  probation: '新同学还在观察期，暂时不能主动找同学聊天。',
  initiation_cap: '这节课主动搭话的次数已经用完了。',
  peer_offline: '这位同学现在不在线。',
  peer_busy: '这位同学正在和别人聊天，请稍后再试。',
  self_busy: '你正在和别人聊天，请先结束这段对话。',
  not_classmate: '这位同学不在你的班里。',
  not_your_turn: '还没轮到你说话，请等对方回复。',
  conversation_ended: '这段对话已经结束了。',
  blocked: '老师拦下了这句话，没有送出去。',
  question_cap: '这节课提问的次数已经用完了。',
  not_called_on: '老师没有点你的名。',
  call_closed: '这次点名已经结束了。',
  not_in_session: '现在不在上课，不能做这个操作。',
}
