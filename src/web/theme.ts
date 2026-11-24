import { createTheme, type MantineColorsTuple } from '@mantine/core'

const accent: MantineColorsTuple = ['#eaf2ff', '#d3e2ff', '#a9c9ff', '#7fb0ff', '#619bff', '#4c8dff', '#3a7df2', '#2c68d1', '#2053aa', '#153e84']
const dark: MantineColorsTuple = ['#e6e9ee', '#c9d1db', '#9aa4b2', '#6b7480', '#2f3843', '#252c35', '#1b222b', '#0b0e12', '#0f1318', '#080a0d']

export const theme = createTheme({
  colors: { accent, dark },
  primaryColor: 'accent',
  primaryShade: 5,
  fontFamily: "'Inter Variable', system-ui, sans-serif",
  fontFamilyMonospace: "'JetBrains Mono Variable', ui-monospace, monospace",
  defaultRadius: 6,
  fontSizes: { xs: '11px', sm: '13px', md: '14px', lg: '16px', xl: '18px' },
})
