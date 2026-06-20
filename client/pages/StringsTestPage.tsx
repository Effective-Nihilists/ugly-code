import React from 'react';
import { Button, Card, PageLayout, Text, useChangeLanguage, useLang, useStrings } from 'ugly-app/client';

export default function StringsTestPage(): React.ReactElement {
  const strings = useStrings();
  const lang = useLang();
  const changeLang = useChangeLanguage();

  return (
    <PageLayout
      header={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 24px' }}>
          <a href="/test">← Test Pages</a>
          <span data-id="strings-title" style={{ fontSize: '1.125rem', fontWeight: 'bold' }}>
            {strings.appName ?? 'Strings'}
          </span>
        </div>
      }
    >
      <div style={{ maxWidth: 640, margin: '0 auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Card>
          <Text weight="bold">Current Language</Text>
          <span data-id="strings-lang">{lang}</span>
        </Card>

        <Card>
          <Text weight="bold">Translated Strings</Text>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            <div data-id="string-welcome">
              <span style={{ opacity: 0.5, fontSize: '0.875rem' }}>welcome: </span>
              <span>{strings.welcome}</span>
            </div>
            <div data-id="string-login">
              <span style={{ opacity: 0.5, fontSize: '0.875rem' }}>login: </span>
              <span>{strings.login}</span>
            </div>
            <div data-id="string-logout">
              <span style={{ opacity: 0.5, fontSize: '0.875rem' }}>logout: </span>
              <span>{strings.logout}</span>
            </div>
            <div data-id="string-loading">
              <span style={{ opacity: 0.5, fontSize: '0.875rem' }}>loading (builtin): </span>
              <span>{strings.loading}</span>
            </div>
            <div data-id="string-cancel">
              <span style={{ opacity: 0.5, fontSize: '0.875rem' }}>cancel (builtin): </span>
              <span>{strings.cancel}</span>
            </div>
          </div>
        </Card>

        <Card>
          <Text weight="bold">Switch Language</Text>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Button
              data-id="lang-en"
              variant={lang === 'en' ? 'primary' : 'secondary'}
              onClick={() => { void changeLang('en'); }}
            >
              English
            </Button>
            <Button
              data-id="lang-es"
              variant={lang === 'es' ? 'primary' : 'secondary'}
              onClick={() => { void changeLang('es'); }}
            >
              Español
            </Button>
          </div>
        </Card>
      </div>
    </PageLayout>
  );
}
