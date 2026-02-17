# 🗺️ Stark AgentPool — Plan d'évolutions

## Vue d'ensemble

Ce dossier contient **21 prompts d'évolution** ordonnés par priorité et interdépendances.
Chaque fichier est un prompt autonome contenant toutes les informations nécessaires pour mener à bien l'évolution correspondante.

---

## Phases et ordre d'exécution

### Phase 1 — Foundation Fixes (P0)
| # | Fichier | Description | Dépend de |
|---|---------|-------------|-----------|
| 01 | `01-fix-agent-subtask-mapping.md` | Fix du bug critique `isAgentForSubtask` qui retourne toujours `false` | — |
| 02 | `02-sharing-deduplication.md` | Historique de partage pour éviter les doublons inter-agents | 01 |

### Phase 2 — Prompt Quality (P1)
| # | Fichier | Description | Dépend de |
|---|---------|-------------|-----------|
| 03 | `03-project-context-planner.md` | Injection du contexte projet dans le planner | — |
| 04 | `04-few-shot-examples.md` | Ajout d'exemples concrets dans tous les prompts LLM | 03 |
| 05 | `05-split-context-analysis-prompts.md` | Séparation du system prompt context-analyzer en rôles spécialisés | — |
| 06 | `06-notification-summary-prompt-cleanup.md` | Nettoyage des prompts notification et summary | 05 |

### Phase 3 — Information Flow (P1-P2)
| # | Fichier | Description | Dépend de |
|---|---------|-------------|-----------|
| 07 | `07-full-prompt-results-sharing.md` | Partage des résultats complets de prompt (pas juste 500 chars) | 01, 02 |
| 08 | `08-structured-context-injection.md` | Injection de contexte structurée et priorisée | 07 |
| 09 | `09-dynamic-significance-threshold.md` | Seuil de significance adaptatif selon le contexte | 01 |

### Phase 4 — Resilience (P2)
| # | Fichier | Description | Dépend de |
|---|---------|-------------|-----------|
| 10 | `10-subtask-timeout-and-retry.md` | Timeout par subtask + mécanisme de retry individuel | — |
| 11 | `11-adaptive-replanning.md` | Re-planification dynamique en cas d'échec ou de changement de contexte | 10 |

### Phase 5 — Conversation Intelligence (P2)
| # | Fichier | Description | Dépend de |
|---|---------|-------------|-----------|
| 12 | `12-multi-intent-analysis.md` | Support multi-intent + historique conversationnel | — |
| 13 | `13-planner-sliding-memory.md` | Mémoire glissante du planner (résumé au lieu de reset total) | 03 |
| 14 | `14-context-analyzer-session-memory.md` | Mémoire de session pour le context analyzer intra-exécution | 05 |
| 15 | `15-mid-execution-checkpoints.md` | Points de contrôle et auto-évaluation en cours d'exécution | 11, 14 |

### Phase 6 — Meta-Intelligence (P2-P3)
| # | Fichier | Description | Dépend de |
|---|---------|-------------|-----------|
| 16 | `16-meta-reflection-orchestrator.md` | Conversation ORCHESTRATOR pour la réflexion cross-conversation | 14, 15 |
| 17 | `17-post-execution-reflection.md` | Cycle Reflect → Learn → Store après chaque exécution | 16 |
| 18 | `18-conflict-detection-feedback.md` | Détection de conflits et canal de feedback inter-agents | 08, 16 |

### Phase 7 — Infrastructure (P3)
| # | Fichier | Description | Dépend de |
|---|---------|-------------|-----------|
| 19 | `19-cost-token-budget-management.md` | Tracking des coûts + gestion du budget tokens avec compression | — |
| 20 | `20-task-queue.md` | File d'attente de tâches (exécution séquentielle/concurrente) | — |

### Phase 8 — Long-term Memory (P3)
| # | Fichier | Description | Dépend de |
|---|---------|-------------|-----------|
| 21 | `21-inter-execution-memory.md` | Mémoire persistante inter-exécutions | 17, 19 |

---

## Graphe de dépendances

```text
01 ──→ 02 ──→ 07 ──→ 08 ──→ 18
 │            │
 │            ↓
 └──→ 09     07
              ↓
03 ──→ 04    08 ──→ 18
 │
 └──→ 13

05 ──→ 06
 │
 └──→ 14 ──→ 15 ──→ 16 ──→ 17 ──→ 21
              ↑            │
             11            └──→ 18
              ↑
             10

12 (indépendant)
19 (indépendant) ──→ 21
20 (indépendant)
```

---

## Règles de lecture des prompts

1. **Chaque prompt liste les évolutions précédentes déjà réalisées** — ne pas re-implémenter ce qui existe déjà.
2. **Les fichiers impactés sont listés avec leurs chemins exacts** — toujours vérifier l'état actuel avant de modifier.
3. **Les tests attendus sont décrits** — ne pas considérer l'évolution terminée sans eux.
4. **Le scope est strict** — ne pas déborder sur les évolutions suivantes même si c'est tentant.
