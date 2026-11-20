import { createFileRoute } from "@tanstack/react-router";

import { TranslationSettings } from "../components/settings/TranslationSettings";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function SettingsTranslationRoute() {
  return (
    <SettingsPageContainer>
      <TranslationSettings />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/translation")({
  component: SettingsTranslationRoute,
});
