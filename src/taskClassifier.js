// Task classifier — matches the model provider's classification to ensure consistent routing.
// Analyzes message content to detect task type (architecture, implementation, debugging, etc).

function normalizeContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  if (content && typeof content === 'object' && 'text' in content && typeof content.text === 'string') {
    return content.text;
  }

  return '';
}

function messagesToText(messages) {
  if (!Array.isArray(messages)) return '';
  return messages
    .map((message) => normalizeContent(message?.content))
    .join('\n')
    .toLowerCase();
}

function countMatches(text, terms) {
  return terms.reduce((count, term) => {
    return count + (text.includes(term.toLowerCase()) ? 1 : 0);
  }, 0);
}

function hasAny(text, terms) {
  return countMatches(text, terms) > 0;
}

function hasRegex(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function makeProfile(taskType, scope, reasoning, urgency, risk) {
  return {
    taskType,
    scope: clamp(scope, 1, 5),
    reasoning: clamp(reasoning, 1, 5),
    urgency: clamp(urgency, 1, 10),
    risk: clamp(risk, 1, 5),
  };
}

// Classify task type from messages
function classifyTask(messages) {
  const text = messagesToText(messages);

  const explicitArchitecture = [
    'architecture', 'architectural', 'system design', 'design the system',
    'design a system', 'technical design', 'design doc', 'rfc', 'adr',
    'high level design', 'high-level design', 'scalability plan',
    'scalable architecture', 'distributed system', 'microservices',
    'service boundaries', 'database schema design', 'data model design',
    'infrastructure plan', 'deployment architecture', 'cloud architecture',
    'migration strategy', 'roadmap', 'tradeoffs', 'trade-offs',
    'pros and cons', 'what approach', 'which approach',
    'recommend an approach', 'plan the implementation', 'project plan',
  ];

  const implementationTerms = [
    'implement', 'build', 'create', 'write', 'add', 'make', 'generate',
    'code', 'component', 'function', 'class', 'api', 'endpoint', 'hook',
    'page', 'screen', 'website', 'app', 'dashboard', 'feature',
    'full file', 'complete file', 'replacement file',
    'output complete files', 'files to provide',
    'src/', '.ts', '.tsx', '.js', '.jsx', '.py', '.json', '.css', '.html',
  ];

  const debuggingTerms = [
    'bug', 'error', 'exception', 'stack trace', 'traceback',
    'failing', 'fails', 'failed', 'broken', 'debug', 'why does',
    'not working', 'doesn\'t work', 'crash', 'crashes', 'timeout',
    'race condition', 'memory leak', 'deadlock', 'fix this',
    'fix the error', 'type error', 'typescript error',
    'compile error', 'runtime error',
  ];

  const refactorTerms = [
    'refactor', 'cleanup', 'clean up', 'simplify', 'reorganize',
    'rename', 'extract', 'deduplicate', 'split into', 'make cleaner',
    'improve readability', 'without changing behavior',
    'keep behavior identical',
  ];

  const docsTerms = [
    'readme', 'documentation', 'docs', 'comment', 'explain',
    'write instructions', 'guide', 'tutorial', 'document this',
    'usage notes',
  ];

  const testingTerms = [
    'test', 'unit test', 'integration test', 'e2e', 'jest', 'vitest',
    'playwright', 'coverage', 'spec file', '.spec.', '.test.',
  ];

  const smallEditTerms = [
    'format', 'typo', 'small change', 'tiny', 'one line',
    'rename variable', 'fix import', 'change the text', 'change copy',
    'update label', 'only change', 'single line',
  ];

  const multiFileSignals = [
    'multiple files', 'several files', 'files to provide', 'complete files',
    'full files', 'src/', 'package.json', 'tsconfig', 'vite.config',
    'tailwind.config',
  ];

  const largeImplementationSignals = [
    'from scratch', 'entire app', 'whole app', 'complete app',
    'full app', 'complete website', 'full website', 'dashboard',
    'responsive website', 'multi-file', 'multiple files', 'files to provide',
  ];

  const explicitArchitectureQuestion = hasRegex(text, [
    /\bhow should (i|we) design\b/,
    /\bwhat architecture\b/,
    /\bwhich architecture\b/,
    /\bdesign an architecture\b/,
    /\bplan (the|a|this) system\b/,
    /\bcompare .* approaches\b/,
    /\btrade-?offs?\b/,
  ]);

  const implementationScore =
    countMatches(text, implementationTerms) * 3 +
    countMatches(text, largeImplementationSignals) * 2 +
    (hasRegex(text, [/```/, /\bfile:\s*[\w./-]+/]) ? 4 : 0);

  const architectureScore =
    countMatches(text, explicitArchitecture) * 4 + (explicitArchitectureQuestion ? 8 : 0);

  const debuggingScore =
    countMatches(text, debuggingTerms) * 4 +
    (hasRegex(text, [/error:\s/i, /typeerror/i, /referenceerror/i, /syntaxerror/i]) ? 5 : 0);

  const refactorScore = countMatches(text, refactorTerms) * 4;
  const testingScore = countMatches(text, testingTerms) * 4;
  const docsScore = countMatches(text, docsTerms) * 3;
  const smallEditScore = countMatches(text, smallEditTerms) * 4;

  const scores = [
    { taskType: 'debugging', score: debuggingScore },
    { taskType: 'refactor', score: refactorScore },
    { taskType: 'testing', score: testingScore },
    { taskType: 'docs', score: docsScore },
    { taskType: 'small_edit', score: smallEditScore },
    { taskType: 'architecture', score: architectureScore },
    { taskType: 'implementation', score: implementationScore },
  ];

  scores.sort((a, b) => b.score - a.score);

  const top = scores[0];
  const isLikelyImplementation =
    implementationScore > 0 && hasAny(text, implementationTerms);
  const isExplicitArchitecture = architectureScore >= 8 || explicitArchitectureQuestion;
  const multiFile = hasAny(text, multiFileSignals);
  const largeImplementation = hasAny(text, largeImplementationSignals);

  if (debuggingScore >= 4 && debuggingScore >= implementationScore) {
    return makeProfile('debugging', multiFile ? 4 : 3, 5, 7, 4);
  }

  if (refactorScore >= 4 && refactorScore >= implementationScore) {
    return makeProfile('refactor', multiFile ? 4 : 3, 3, 5, 3);
  }

  if (testingScore >= 4 && testingScore >= implementationScore) {
    return makeProfile('testing', 3, 3, 5, 3);
  }

  if (smallEditScore >= 4 && !largeImplementation && !multiFile) {
    return makeProfile('small_edit', 1, 1, 7, 1);
  }

  if (docsScore >= 4 && implementationScore === 0) {
    return makeProfile('docs', 2, 2, 4, 1);
  }

  if (isExplicitArchitecture && architectureScore > implementationScore + 3) {
    return makeProfile('architecture', 5, 5, 5, 4);
  }

  if (isLikelyImplementation) {
    return makeProfile(
      'implementation',
      largeImplementation || multiFile ? 4 : 3,
      largeImplementation || multiFile ? 4 : 3,
      5,
      largeImplementation || multiFile ? 4 : 3,
    );
  }

  if (top && top.score > 0) {
    if (top.taskType === 'architecture') {
      return makeProfile('architecture', 5, 5, 5, 4);
    }

    if (top.taskType === 'debugging') {
      return makeProfile('debugging', 3, 5, 7, 4);
    }

    if (top.taskType === 'refactor') {
      return makeProfile('refactor', 3, 3, 5, 3);
    }

    if (top.taskType === 'testing') {
      return makeProfile('testing', 3, 3, 5, 3);
    }

    if (top.taskType === 'docs') {
      return makeProfile('docs', 2, 2, 4, 1);
    }

    if (top.taskType === 'small_edit') {
      return makeProfile('small_edit', 1, 1, 7, 1);
    }
  }

  return makeProfile('implementation', 3, 3, 5, 3);
}

module.exports = { classifyTask };
