import { ConfigProvider } from 'antd'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'
import { antdSettings } from './theme.js'

const root = document.getElementById('root')
if (root === null) throw new Error('index.html has no #root')

createRoot(root).render(
  <StrictMode>
    <ConfigProvider {...antdSettings}>
      <App />
    </ConfigProvider>
  </StrictMode>,
)
// CI trial, not for merging
