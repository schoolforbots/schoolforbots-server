import type { ConfigProviderProps, ThemeConfig } from 'antd'
import zhCN from 'antd/locale/zh_CN'

/** Blackboard green: white text on it is 7.49:1. */
export const PRIMARY = '#2f5d50'
/** The red pen: kept for review marks, and for the one alarm the school data page raises (spend over budget). */
export const RED_PEN = '#c8312b'

export const theme: ThemeConfig = {
  token: {
    colorPrimary: PRIMARY,
    colorLink: PRIMARY,
    colorError: RED_PEN,
    borderRadius: 6,
    motion: false,
    fontFamily: '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif',
    // Neutral greys that all reach 4.5:1 on white and on the page background (Ant Design's own lighter greys,
    // used for descriptions and placeholders, do not).
    colorText: '#1f1f1f',
    colorTextSecondary: '#4a4a4a',
    colorTextTertiary: '#5c5c5c',
    colorTextDescription: '#5c5c5c',
    colorTextPlaceholder: '#767676',
    colorBgLayout: '#f7f6f2',
    colorBorderSecondary: '#e3e2dc',
    // The focus ring: 3px of the green itself, not its pale tint, so a focused control stands out on white and a
    // focused green button keeps a white gap between it and its ring.
    colorPrimaryBorder: PRIMARY,
    lineWidthFocus: 3,
  },
  components: {
    // A focused field gets a 2px green edge (its 1px border and this 1px ring) instead of a faint glow. A field left
    // empty is marked in dark grey, with words: the red stays with the review marks.
    Input: { activeShadow: `0 0 0 1px ${PRIMARY}`, colorError: '#4a4a4a', colorErrorBorderHover: '#1f1f1f' },
    Form: { colorError: '#4a4a4a' },
  },
}

/** Everything the pages hand to Ant Design's `ConfigProvider`. */
export const antdSettings: ConfigProviderProps = {
  theme,
  locale: zhCN,
  // Ant Design spaces out a two-character button label (登 录); the pages write their labels as they mean them.
  button: { autoInsertSpace: false },
  // No ripple on click: the pages do not move. (It is also the one place Ant Design 5 would render with React 18's
  // API and warn about React 19.)
  wave: { disabled: true },
}
