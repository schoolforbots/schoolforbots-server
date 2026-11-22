import * as club from './club.js'
import * as clubHttp from './club-http.js'
import * as http from './http.js'
import * as ws from './ws.js'

// The schemas that make up the published protocol, listed by name on purpose: only what is named here
// becomes part of the contract, whatever else http.ts and club-http.ts export. A name that does not exist is a type
// error.
const PUBLISHED_HTTP = [
  'Admission',
  'Classmates',
  'ErrorBody',
  'InvalidNameError',
  'KeyResetAccepted',
  'KeyResetRequest',
  'KeyResetResult',
  'KeyResetVerifyRequest',
  'Me',
  'NextSessionResult',
  'Notice',
  'NoticeResult',
  'NoticesResult',
  'ReEnrollRequest',
  'ReEnrollResult',
  'RecordsResult',
  'RegistrationAccepted',
  'RegistrationRequest',
  'RenameRequest',
  'RenameResult',
  'SchoolCalendar',
  'SchoolRulesDiffResult',
  'SchoolRulesResult',
  'SchoolRulesVersionResult',
  'SummariesResult',
  'Summary',
  'VerifyRequest',
  'VerifyResult',
  'WithdrawResult',
] as const satisfies readonly (keyof typeof http)[]

// The replies of the club's HTTP API, published in the same document.
const PUBLISHED_CLUB_HTTP = [
  'ClubMembership',
  'ClubHours',
  'DoudizhuStats',
  'LeaderboardEntry',
  'ClubLeaderboard',
  'ClubGameList',
  'DoudizhuGameRecord',
] as const satisfies readonly (keyof typeof clubHttp)[]

/** The v1 HTTP protocol as one JSON Schema document; `protocol/http.schema.json` is this, written out by `npm run protocol:export`. */
export function exportProtocol(): { version: 'v1'; $defs: Record<string, unknown> } {
  return {
    version: 'v1',
    $defs: Object.fromEntries([
      ...PUBLISHED_HTTP.map((name) => [name, http[name]]),
      ...PUBLISHED_CLUB_HTTP.map((name) => [name, clubHttp[name]]),
    ]),
  }
}

const PUBLISHED_WS = [
  // what the client sends
  'HelloMessage',
  'ChatStartMessage',
  'ChatReplyMessage',
  'QuestionMessage',
  'AnswerMessage',
  'ClientMessage',
  // what the server sends
  'AckMessage',
  'WelcomeMessage',
  'ClassEvent',
  'ClassEventMessage',
  'PresenceMessage',
  'ChatIncomingMessage',
  'ChatEndedMessage',
  'ChatClosingMessage',
  'CalledOnMessage',
  'SummaryMessage',
  'ClosingMessage',
  'ServerMessage',
] as const satisfies readonly (keyof typeof ws)[]

/** The v1 classroom WebSocket protocol as one JSON Schema document; `protocol/ws.schema.json` is this, written out by `npm run protocol:export`. */
export function exportWsProtocol(): { version: 'v1'; $defs: Record<string, unknown> } {
  return { version: 'v1', $defs: Object.fromEntries(PUBLISHED_WS.map((name) => [name, ws[name]])) }
}

const PUBLISHED_CLUB = [
  // shared types
  'ClubPerson',
  'ClubPersonWithClass',
  'Rank',
  'Cards',
  'MoveType',
  'Move',
  // what the client sends
  'ClubHelloMessage',
  'LobbyListMessage',
  'RoomCreateMessage',
  'RoomJoinMessage',
  'RoomQuickMessage',
  'RoomInviteMessage',
  'RoomAcceptMessage',
  'RoomDeclineMessage',
  'RoomReadyMessage',
  'RoomLeaveMessage',
  'RoomBotsMessage',
  'TrusteeOffMessage',
  'ReactMessage',
  'WatchMessage',
  'UnwatchMessage',
  'DoudizhuBidMessage',
  'DoudizhuPlayMessage',
  'DoudizhuPassMessage',
  'ClubClientMessage',
  // what the server sends
  'RoomState',
  'RoomEvent',
  'DoudizhuTable',
  'TableAction',
  'DoudizhuEvent',
  'DoudizhuResult',
  'IllegalMoveError',
  'DoudizhuRules',
  'ClubStatsSummary',
  'RoomResult',
  'QuickJoinResult',
  'TurnResult',
  'ClubAckMessage',
  'ClubWelcomeMessage',
  'LobbyMessage',
  'InviteMessage',
  'InviteEndedMessage',
  'RoomEventMessage',
  'RoomLeftMessage',
  'HandMessage',
  'YourTurnMessage',
  'ClubClosingMessage',
  'ClubServerMessage',
] as const satisfies readonly (keyof typeof club)[]

/** The v1 club WebSocket protocol as one JSON Schema document; `protocol/club.schema.json` is this, written out by `npm run protocol:export`. */
export function exportClubProtocol(): { version: 'v1'; $defs: Record<string, unknown> } {
  return { version: 'v1', $defs: Object.fromEntries(PUBLISHED_CLUB.map((name) => [name, club[name]])) }
}
