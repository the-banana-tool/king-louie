function isFirstRun(store) {
  return !store.get('onboardingComplete');
}

function completeOnboarding(store) {
  store.set('onboardingComplete', true);
}

function getWizardSteps() {
  return [
    {
      id: 'welcome',
      title: 'Welcome to King Louie',
      description: 'A brief introduction to your new desktop chat companion.',
      optional: false,
      validate: () => true,
    },
    {
      id: 'provider',
      title: 'Select Provider',
      description: 'Choose your AI provider and enter your API key.',
      optional: false,
      validate: (data) =>
        typeof data.provider === 'string' &&
        data.provider.length > 0 &&
        typeof data.apiKey === 'string' &&
        data.apiKey.length > 0,
    },
    {
      id: 'profile',
      title: 'Your Profile',
      description: 'Set your display name and role.',
      optional: false,
      validate: (data) =>
        typeof data.name === 'string' && data.name.length > 0,
    },
    {
      id: 'channels',
      title: 'Enable Channels',
      description: 'Connect Telegram by providing your bot token.',
      optional: true,
      validate: () => true,
    },
    {
      id: 'finish',
      title: 'All Set!',
      description: 'Review your choices and finish onboarding.',
      optional: false,
      validate: () => true,
    },
  ];
}

module.exports = { isFirstRun, completeOnboarding, getWizardSteps };
