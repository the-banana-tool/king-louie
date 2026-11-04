function isFirstRun(store) {
  return !store.get('onboardingComplete');
}

function completeOnboarding(store) {
  store.set('onboardingComplete', true);
}

// Attached, the window is a client of a node (attach stage 2 spec §6.3): the
// setup flow has already introduced it, and its channels are the node's.
function getWizardSteps({ attached = false } = {}) {
  const welcome = {
    id: 'welcome',
    title: 'Welcome to King Louie',
    description: 'A brief introduction to your new desktop chat companion.',
    optional: false,
    validate: () => true,
  };
  const channels = {
    id: 'channels',
    title: 'Enable Channels',
    description: 'Connect Telegram by providing your bot token.',
    optional: true,
    validate: () => true,
  };
  const phone = {
    id: 'phone',
    title: 'Your Phone',
    description: 'Approve what King Louie does while you are away. Optional; it is set up from a terminal.',
    optional: true,
    validate: () => true,
  };
  const [provider, profile, finish] = [
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
      id: 'finish',
      title: 'All Set!',
      description: 'Review your choices and finish onboarding.',
      optional: false,
      validate: () => true,
    },
  ];
  return attached ? [provider, profile, phone, finish] : [welcome, provider, profile, channels, finish];
}

module.exports = { isFirstRun, completeOnboarding, getWizardSteps };
