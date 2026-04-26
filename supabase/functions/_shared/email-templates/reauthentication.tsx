/// <reference types="npm:@types/react@18.3.1" />

import * as React from 'npm:react@18.3.1'

import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
} from 'npm:@react-email/components@0.0.22'

interface ReauthenticationEmailProps {
  token: string
}

export const ReauthenticationEmail = ({ token }: ReauthenticationEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>Your verification code</Preview>
    <Body style={main}>
      <Container style={container}>
        <Section style={brandBar}>
          <Text style={brandText}>RowFantasy</Text>
        </Section>
        <Heading style={h1}>Confirm reauthentication</Heading>
        <Text style={text}>Use the code below to confirm your identity:</Text>
        <Text style={codeStyle}>{token}</Text>
        <Text style={footer}>
          This code will expire shortly. If you didn't request this, you can
          safely ignore this email.
        </Text>
      </Container>
    </Body>
  </Html>
)

export default ReauthenticationEmail

const main = {
  backgroundColor: '#ffffff',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
}
const container = { padding: '32px 28px', maxWidth: '560px' }
const brandBar = {
  borderBottom: '2px solid hsl(168, 76%, 50%)',
  paddingBottom: '12px',
  marginBottom: '28px',
}
const brandText = {
  fontSize: '18px',
  fontWeight: 'bold' as const,
  color: 'hsl(217, 91%, 12%)',
  margin: '0',
  letterSpacing: '0.5px',
}
const h1 = {
  fontSize: '24px',
  fontWeight: 'bold' as const,
  color: 'hsl(222, 47%, 11%)',
  margin: '0 0 20px',
  lineHeight: '1.3',
}
const text = {
  fontSize: '15px',
  color: 'hsl(215, 16%, 35%)',
  lineHeight: '1.6',
  margin: '0 0 20px',
}
const codeStyle = {
  fontFamily: 'Courier, monospace',
  fontSize: '28px',
  fontWeight: 'bold' as const,
  color: 'hsl(217, 91%, 12%)',
  letterSpacing: '4px',
  backgroundColor: 'hsl(210, 20%, 96%)',
  borderRadius: '12px',
  padding: '16px 20px',
  textAlign: 'center' as const,
  margin: '0 0 30px',
}
const footer = {
  fontSize: '12px',
  color: 'hsl(215, 16%, 55%)',
  margin: '32px 0 0',
  lineHeight: '1.5',
}
