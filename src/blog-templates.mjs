export const BLOG_TEMPLATE_IDS = Object.freeze([
  'default',
  'productExplainer',
  'alternatingContent',
  'alternative',
  'tutorial',
  'solution',
  'faq',
  'caseStudy',
])

export const BLOG_TEMPLATE_REQUIREMENTS = Object.freeze({
  default: Object.freeze({}),
  productExplainer: Object.freeze({mediaText: 1, faqSection: 1, cta: 1}),
  alternatingContent: Object.freeze({mediaText: 2, cta: 1}),
  alternative: Object.freeze({table: 1, faqSection: 1, cta: 1}),
  tutorial: Object.freeze({tutorialSteps: 1, faqSection: 1, cta: 1}),
  solution: Object.freeze({mediaText: 1, cta: 1}),
  faq: Object.freeze({faqSection: 1, cta: 1}),
  caseStudy: Object.freeze({mediaText: 1, cta: 1}),
})

export const BLOG_TEMPLATE_PRESETS = Object.freeze({
  default: Object.freeze({
    tone: 'editorial',
    mediaStyle: 'contained',
    heroVariant: 'legacy',
    contentWidth: 'reading',
    stepNavigation: false,
  }),
  productExplainer: Object.freeze({
    tone: 'feature',
    mediaStyle: 'wide',
    heroVariant: 'split',
    contentWidth: 'wide',
    stepNavigation: false,
  }),
  alternatingContent: Object.freeze({
    tone: 'feature',
    mediaStyle: 'alternating',
    heroVariant: 'split',
    contentWidth: 'wide',
    stepNavigation: false,
  }),
  alternative: Object.freeze({
    tone: 'editorial',
    mediaStyle: 'wide',
    heroVariant: 'compact',
    contentWidth: 'wide',
    stepNavigation: false,
  }),
  tutorial: Object.freeze({
    tone: 'steps',
    mediaStyle: 'contained',
    heroVariant: 'compact',
    contentWidth: 'reading',
    stepNavigation: true,
  }),
  solution: Object.freeze({
    tone: 'feature',
    mediaStyle: 'contained',
    heroVariant: 'split',
    contentWidth: 'wide',
    stepNavigation: false,
  }),
  faq: Object.freeze({
    tone: 'answers',
    mediaStyle: 'contained',
    heroVariant: 'compact',
    contentWidth: 'reading',
    stepNavigation: false,
  }),
  caseStudy: Object.freeze({
    tone: 'proof',
    mediaStyle: 'wide',
    heroVariant: 'editorial',
    contentWidth: 'wide',
    stepNavigation: false,
  }),
})

export function resolveBlogTemplate(template) {
  return BLOG_TEMPLATE_IDS.includes(template) ? template : 'default'
}

export function getBlogTemplatePreset(template) {
  return BLOG_TEMPLATE_PRESETS[resolveBlogTemplate(template)]
}

export function validateBlogTemplate(article) {
  const template = resolveBlogTemplate(article?.template)
  const requirements = BLOG_TEMPLATE_REQUIREMENTS[template]
  const issues = []

  for (const locale of ['en', 'zh']) {
    const body = article?.body?.[locale] ?? []
    const counts = body.reduce((values, item) => {
      values[item?._type] = (values[item?._type] ?? 0) + 1
      return values
    }, {})

    for (const [blockType, minimum] of Object.entries(requirements)) {
      if ((counts[blockType] ?? 0) >= minimum) continue
      issues.push({
        path: ['body', locale],
        message: `Template "${template}" requires at least ${minimum} ${blockType} block${
          minimum === 1 ? '' : 's'
        } in ${locale}.`,
      })
    }

    if (template === 'tutorial') {
      const stepCount = body
        .filter((item) => item?._type === 'tutorialSteps')
        .reduce((total, item) => total + item.steps.length, 0)
      if (stepCount < 2) {
        issues.push({
          path: ['body', locale],
          message: 'Template "tutorial" requires at least 2 tutorial steps in each locale.',
        })
      }
    }
  }

  return issues
}
