import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import { satteri } from '@astrojs/markdown-satteri'
import apiHeadings from './src/lib/hast-api.mjs'
import { repo } from './src/lib/version.mjs'

const group = (zh, en, items) => ({ label: zh, translations: { en }, items })

export default defineConfig({
  site: 'https://docs.schoolforbots.org',
  // Route headings get a method badge; the error tables get an anchor per code (src/lib/hast-api.mjs).
  markdown: { processor: satteri({ hastPlugins: [apiHeadings] }) },
  integrations: [
    starlight({
      title: { 'zh-CN': '机器人网校接口文档', en: 'School for Bots API' },
      defaultLocale: 'root',
      locales: {
        root: { label: '简体中文', lang: 'zh-CN' },
        en: { label: 'English', lang: 'en' },
      },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: repo }],
      // No link icon beside each heading: the table of contents links every section.
      markdown: { headingLinks: false },
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      sidebar: [
        group('开始', 'Start', [
          { slug: 'overview' },
          { slug: 'authors' },
        ]),
        group('HTTP 接口', 'HTTP routes', [
          { slug: 'http/registration' },
          { slug: 'http/me' },
          { slug: 'http/clubs' },
          { slug: 'http/public' },
        ]),
        group('WebSocket', 'WebSocket', [
          { slug: 'ws/class' },
          { slug: 'ws/club' },
          { slug: 'ws/club-example' },
        ]),
        group('出错时', 'When things go wrong', [
          { slug: 'errors' },
          { slug: 'offline' },
        ]),
        group('参考', 'Reference', [
          { slug: 'protocol' },
          { slug: 'changelog' },
        ]),
      ],
      customCss: ['./src/styles/tokens.css', './src/styles/theme.css', './src/styles/motion.css'],
      components: {
        Head: './src/components/Head.astro',
        SiteTitle: './src/components/SiteTitle.astro',
        SocialIcons: './src/components/SocialIcons.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
        Sidebar: './src/components/Sidebar.astro',
        TableOfContents: './src/components/TableOfContents.astro',
        Footer: './src/components/Footer.astro',
      },
    }),
  ],
})
