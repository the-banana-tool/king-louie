class UserProfile {
  constructor(options = {}) {
    this.getStoredProfile =
      typeof options.getStoredProfile === 'function'
        ? options.getStoredProfile
        : () => null;
    this.setStoredProfile =
      typeof options.setStoredProfile === 'function'
        ? options.setStoredProfile
        : () => null;
  }

  static getDefaultProfile() {
    return {
      name: '',
      role: '',
      goals: [],
      preferences: {},
      projectContext: ''
    };
  }

  normalizeProfile(profile = {}) {
    const source = profile || {};
    return {
      name: String(source.name || '').trim(),
      role: String(source.role || '').trim(),
      goals: Array.isArray(source.goals)
        ? source.goals
            .map((goal) => String(goal || '').trim())
            .filter(Boolean)
        : [],
      preferences:
        source.preferences && typeof source.preferences === 'object' && !Array.isArray(source.preferences)
          ? { ...source.preferences }
          : {},
      projectContext: String(source.projectContext || '').trim()
    };
  }

  getProfile() {
    return this.normalizeProfile({
      ...UserProfile.getDefaultProfile(),
      ...(this.getStoredProfile() || {})
    });
  }

  updateProfile(updates = {}) {
    const current = this.getProfile();
    const next = this.normalizeProfile({
      ...current,
      ...(updates || {})
    });

    this.setStoredProfile(next);
    return next;
  }

  toTemplateContext(profile = this.getProfile()) {
    const normalized = this.normalizeProfile(profile);
    const goalsText = normalized.goals.join('; ');
    const preferencesText = Object.keys(normalized.preferences || {}).length
      ? JSON.stringify(normalized.preferences)
      : '';

    return {
      user: {
        name: normalized.name,
        role: normalized.role,
        goals: goalsText,
        preferences: preferencesText
      },
      project: {
        context: normalized.projectContext
      }
    };
  }
}

module.exports = UserProfile;