import type pino from "pino";
import type {
	TokenBudgetConfig,
	UsageBreakdown,
	UsageEntry,
	UsageSnapshot,
} from "../../types/agent-pool.types.ts";
import { isoNow } from "../../utils/formatting.ts";

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Sources de consommation reconnues par le cost tracker.
 * Correspond aux clés de `UsageBreakdown`.
 */
export type UsageSource =
	| "agents"
	| "planner"
	| "sharingAnalyzer"
	| "contextAnalyzer"
	| "intentAnalyzer"
	| "orchestrator"
	| "checkpoint"
	| "reflection"
	| "userInteraction"
	| "compression";

/**
 * Signal retourné par `checkBudget()` indiquant l'état du budget.
 */
export type BudgetSignal =
	| { readonly type: "ok" }
	| {
			readonly type: "warning";
			readonly budgetType: "tokens" | "cost";
			readonly percent: number;
	  }
	| { readonly type: "exceeded"; readonly budgetType: "tokens" | "cost" };

// ── Internal counter type ──────────────────────────────────────────────────

interface MutableUsageCounter {
	callCount: number;
	inputTokens: number;
	outputTokens: number;
	estimatedCostUsd: number;
}

// ── CostTracker ────────────────────────────────────────────────────────────

/**
 * Agrégateur de consommation tokens/coût pour l'AgentPool.
 *
 * Collecte les données de consommation depuis :
 * - Les agents (via les événements USAGE_UPDATE capturés par le ContextTracker)
 * - Les appels LLM de la pool (via instrumentation du ConversationManager)
 *
 * Le tracker est un composant passif — il ne prend aucune action automatique.
 * L'AgentPool interroge le tracker après chaque appel LLM et prend les
 * décisions appropriées (émettre un warning, pauser, ou aborter).
 *
 * ## Budget Management
 *
 * Le budget est optionnel. Quand configuré, le tracker compare la
 * consommation courante aux limites définies et retourne un `BudgetSignal`
 * que le pool peut convertir en événement et/ou action.
 *
 * Le warning est émis une seule fois quand le seuil est franchi (sticky flag).
 * Le exceeded est évalué à chaque appel à `checkBudget()`.
 *
 * ## Thread Safety
 *
 * Le tracker est conçu pour un accès séquentiel (JavaScript single-threaded).
 * Les `record*()` et `checkBudget()` sont safe à appeler depuis des handlers
 * async concurrents car les mutations sont atomiques (pas d'await entre
 * lecture et écriture).
 *
 * @example
 * ```ts
 * const tracker = new CostTracker(budgetConfig, logger);
 *
 * tracker.recordPoolCall("planner", 1200, 800, 0.003);
 * tracker.recordAgentUsage("agent-1", 5000, 2000, 0.01);
 *
 * const signal = tracker.checkBudget();
 * if (signal.type === "warning") {
 *   pool.emitPoolEvent(PoolEvent.BUDGET_WARNING, ...);
 * }
 *
 * const snapshot = tracker.getSnapshot();
 * console.log(snapshot.totalTokens); // 9000
 * ```
 */
export class CostTracker {
	/** Compteurs par source. */
	private readonly counters: Record<UsageSource, MutableUsageCounter>;

	/** Configuration du budget (optionnelle). */
	private readonly budget: TokenBudgetConfig | null;

	/** Indique si le warning a déjà été émis (sticky). */
	private _warningEmitted = false;

	/** Indique si le budget a été dépassé. */
	private _exceeded = false;

	/** Indique si le pool est en mode "paused" (plus de nouveaux appels LLM de la pool). */
	private _paused = false;

	constructor(
		budget: TokenBudgetConfig | null,
		private readonly logger: pino.Logger,
	) {
		this.budget = budget;

		const emptyEntry = (): MutableUsageCounter => ({
			callCount: 0,
			inputTokens: 0,
			outputTokens: 0,
			estimatedCostUsd: 0,
		});

		this.counters = {
			agents: emptyEntry(),
			planner: emptyEntry(),
			sharingAnalyzer: emptyEntry(),
			contextAnalyzer: emptyEntry(),
			intentAnalyzer: emptyEntry(),
			orchestrator: emptyEntry(),
			checkpoint: emptyEntry(),
			reflection: emptyEntry(),
			userInteraction: emptyEntry(),
			compression: emptyEntry(),
		};
	}

	// ── Recording ──────────────────────────────────────────────────────

	/**
	 * Enregistre la consommation d'un appel LLM de la pool.
	 *
	 * Appelé par le ConversationManager (ou directement par le pool)
	 * après chaque appel réussi à l'OpenRouter API.
	 *
	 * @param source - La source de l'appel (planner, sharingAnalyzer, etc.)
	 * @param inputTokens - Nombre de tokens d'entrée.
	 * @param outputTokens - Nombre de tokens de sortie.
	 * @param costUsd - Coût en USD (si fourni par OpenRouter).
	 */
	recordPoolCall(
		source: UsageSource,
		inputTokens: number,
		outputTokens: number,
		costUsd?: number,
	): void {
		const entry = this.counters[source];
		entry.callCount++;
		entry.inputTokens += inputTokens;
		entry.outputTokens += outputTokens;
		if (costUsd !== undefined) {
			entry.estimatedCostUsd += costUsd;
		}

		this.logger.debug(
			{
				source,
				inputTokens,
				outputTokens,
				costUsd,
				totalForSource: entry.inputTokens + entry.outputTokens,
			},
			`Cost tracked: ${source} +${inputTokens + outputTokens} tokens`,
		);
	}

	/**
	 * Enregistre la consommation d'un agent (depuis un événement USAGE_UPDATE).
	 *
	 * Les données proviennent du ContextTracker qui capture les événements
	 * USAGE_UPDATE émis par les agents ACP.
	 *
	 * @param agentId - L'agent qui a consommé.
	 * @param inputTokens - Nombre de tokens d'entrée.
	 * @param outputTokens - Nombre de tokens de sortie.
	 * @param costUsd - Coût en USD (si disponible).
	 */
	recordAgentUsage(
		agentId: string,
		inputTokens: number,
		outputTokens: number,
		costUsd?: number,
	): void {
		const entry = this.counters.agents;
		entry.callCount++;
		entry.inputTokens += inputTokens;
		entry.outputTokens += outputTokens;
		if (costUsd !== undefined) {
			entry.estimatedCostUsd += costUsd;
		}

		this.logger.debug(
			{
				agentId,
				inputTokens,
				outputTokens,
				costUsd,
			},
			`Agent cost tracked: ${agentId} +${inputTokens + outputTokens} tokens`,
		);
	}

	// ── Budget Evaluation ──────────────────────────────────────────────

	/**
	 * Évalue l'état du budget et retourne un signal.
	 *
	 * Le signal `warning` est retourné une seule fois (sticky flag).
	 * Le signal `exceeded` est retourné à chaque appel tant que le budget
	 * est dépassé (permet au pool de réagir même s'il a ignoré le premier).
	 *
	 * @returns Un `BudgetSignal` indiquant l'état actuel.
	 */
	checkBudget(): BudgetSignal {
		if (!this.budget) {
			return { type: "ok" };
		}

		const total = this.getTotalTokens();
		const totalCost = this.getTotalCost();

		// Check token budget
		if (this.budget.maxTotalTokens && this.budget.maxTotalTokens > 0) {
			const percent = total / this.budget.maxTotalTokens;

			if (percent >= 1.0) {
				this._exceeded = true;
				return { type: "exceeded", budgetType: "tokens" };
			}

			const warningThreshold = this.budget.warningThreshold ?? 0.8;
			if (percent >= warningThreshold && !this._warningEmitted) {
				this._warningEmitted = true;
				return { type: "warning", budgetType: "tokens", percent };
			}
		}

		// Check cost budget
		if (
			this.budget.maxCostUsd &&
			this.budget.maxCostUsd > 0 &&
			totalCost !== null
		) {
			const percent = totalCost / this.budget.maxCostUsd;

			if (percent >= 1.0) {
				this._exceeded = true;
				return { type: "exceeded", budgetType: "cost" };
			}

			const warningThreshold = this.budget.warningThreshold ?? 0.8;
			if (percent >= warningThreshold && !this._warningEmitted) {
				this._warningEmitted = true;
				return { type: "warning", budgetType: "cost", percent };
			}
		}

		return { type: "ok" };
	}

	// ── Snapshots ──────────────────────────────────────────────────────

	/**
	 * Produit un snapshot complet de la consommation courante.
	 *
	 * Le snapshot est une copie — les mutations ultérieures du tracker
	 * n'affectent pas les snapshots déjà produits.
	 */
	getSnapshot(): UsageSnapshot {
		const breakdown = this.getBreakdown();
		const totalTokens = this.getTotalTokens();
		const totalCost = this.getTotalCost();

		return {
			inputTokens: this.getTotalInputTokens(),
			outputTokens: this.getTotalOutputTokens(),
			totalTokens,
			estimatedCostUsd: totalCost,
			breakdown,
			timestamp: isoNow(),
		};
	}

	// ── Aggregation Helpers ────────────────────────────────────────────

	/**
	 * Retourne le nombre total de tokens consommés (toutes sources).
	 */
	getTotalTokens(): number {
		let total = 0;
		for (const entry of Object.values(this.counters)) {
			total += entry.inputTokens + entry.outputTokens;
		}
		return total;
	}

	/**
	 * Retourne le nombre total de tokens d'entrée (toutes sources).
	 */
	getTotalInputTokens(): number {
		let total = 0;
		for (const entry of Object.values(this.counters)) {
			total += entry.inputTokens;
		}
		return total;
	}

	/**
	 * Retourne le nombre total de tokens de sortie (toutes sources).
	 */
	getTotalOutputTokens(): number {
		let total = 0;
		for (const entry of Object.values(this.counters)) {
			total += entry.outputTokens;
		}
		return total;
	}

	/**
	 * Retourne le coût total estimé en USD, ou null si aucune donnée de coût.
	 */
	getTotalCost(): number | null {
		let total = 0;
		let hasCost = false;
		for (const entry of Object.values(this.counters)) {
			if (entry.estimatedCostUsd > 0) {
				hasCost = true;
				total += entry.estimatedCostUsd;
			}
		}
		return hasCost ? total : null;
	}

	/**
	 * Retourne le pourcentage du budget consommé (0.0-1.0).
	 * `null` si aucun budget n'est configuré.
	 */
	getBudgetUsagePercent(): number | null {
		if (!this.budget) return null;

		if (this.budget.maxTotalTokens && this.budget.maxTotalTokens > 0) {
			return Math.min(1.0, this.getTotalTokens() / this.budget.maxTotalTokens);
		}

		const totalCost = this.getTotalCost();
		if (
			this.budget.maxCostUsd &&
			this.budget.maxCostUsd > 0 &&
			totalCost !== null
		) {
			return Math.min(1.0, totalCost / this.budget.maxCostUsd);
		}

		return null;
	}

	// ── State Accessors ────────────────────────────────────────────────

	/** Whether the budget has been exceeded. */
	get isExceeded(): boolean {
		return this._exceeded;
	}

	/** Whether the pool LLM calls are paused due to budget. */
	get isPaused(): boolean {
		return this._paused;
	}

	/** Pause pool LLM calls due to budget exceeded. */
	pause(): void {
		this._paused = true;
		this.logger.warn("Pool LLM calls paused due to budget limit");
	}

	/** Whether the warning threshold has been reached. */
	get warningEmitted(): boolean {
		return this._warningEmitted;
	}

	/**
	 * Nombre total d'appels LLM effectués (toutes sources).
	 */
	get totalCallCount(): number {
		let total = 0;
		for (const entry of Object.values(this.counters)) {
			total += entry.callCount;
		}
		return total;
	}

	// ── Lifecycle ──────────────────────────────────────────────────────

	/**
	 * Resets all counters and flags. Called between executions.
	 */
	reset(): void {
		for (const entry of Object.values(this.counters)) {
			entry.callCount = 0;
			entry.inputTokens = 0;
			entry.outputTokens = 0;
			entry.estimatedCostUsd = 0;
		}
		this._warningEmitted = false;
		this._exceeded = false;
		this._paused = false;
	}

	// ── Private ────────────────────────────────────────────────────────

	/**
	 * Retourne le détail par source sous forme de `UsageBreakdown`.
	 */
	private getBreakdown(): UsageBreakdown {
		const toEntry = (source: UsageSource): UsageEntry => {
			const c = this.counters[source];
			return {
				callCount: c.callCount,
				totalTokens: c.inputTokens + c.outputTokens,
				inputTokens: c.inputTokens,
				outputTokens: c.outputTokens,
				estimatedCostUsd: c.estimatedCostUsd > 0 ? c.estimatedCostUsd : null,
			};
		};

		return {
			agents: toEntry("agents"),
			planner: toEntry("planner"),
			sharingAnalyzer: toEntry("sharingAnalyzer"),
			contextAnalyzer: toEntry("contextAnalyzer"),
			intentAnalyzer: toEntry("intentAnalyzer"),
			orchestrator: toEntry("orchestrator"),
			checkpoint: toEntry("checkpoint"),
			reflection: toEntry("reflection"),
			userInteraction: toEntry("userInteraction"),
			compression: toEntry("compression"),
		};
	}
}
