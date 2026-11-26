"""Replication in the multi-period binomial model (Continuous-Time Finance, lecture 2).

The stock moves from S to uS or dS each period, the bank account grows by the gross rate R. At every node the
option is replicated by Delta shares and B in the bank:

    Delta = (V_u - V_d) / (S_u - S_d),        B = (V_u - Delta S_u) / R,        V = Delta S + B

equivalently V = [pi V_u + (1 - pi) V_d] / R with the risk-neutral probability pi = (R - d) / (u - d), which
exists (and lies in (0, 1)) if and only if d < R < u: absence of arbitrage. The hedge is self-financing: the
portfolio set at a node is worth, at each child node, exactly the cost of the portfolio set there.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field


@dataclass
class Node:
    step: int
    ups: int
    spot: float
    value: float
    payoff: float                 # exercise value (payoff at maturity)
    delta: float | None = None    # hedge set at this node (None at maturity)
    bond: float | None = None
    pi: float | None = None
    exercised: bool = False
    parent_portfolio_value: float | None = None   # value here of the hedge set at the parent node(s)
    path_count: int = 1                           # number of paths reaching the node
    probability: float = 1.0                      # risk-neutral probability of reaching the node


@dataclass
class ReplicationTree:
    S0: float
    u: float
    d: float
    R: float
    K: float
    option_type: str
    steps: int
    american: bool
    pi: float
    nodes: list[list[Node]] = field(default_factory=list)

    @property
    def price(self) -> float:
        return self.nodes[0][0].value

    def node(self, step: int, ups: int) -> Node:
        return self.nodes[step][ups]

    def direct_value(self) -> float:
        """European value as the discounted risk-neutral expectation over terminal nodes (sum over paths)."""
        return sum(n.probability * n.payoff for n in self.nodes[-1]) / self.R**self.steps


def payoff(S: float, K: float, option_type: str) -> float:
    return max(S - K, 0.0) if option_type == "call" else max(K - S, 0.0)


def build_tree(S0: float, u: float, d: float, R: float, K: float, option_type: str = "put", steps: int = 2,
               american: bool = False) -> ReplicationTree:
    if not d < R < u:
        raise ValueError("arbitrage: the model needs d < R < u")
    if steps < 1:
        raise ValueError("at least one period")
    pi = (R - d) / (u - d)
    nodes = [[None] * (i + 1) for i in range(steps + 1)]
    for i in range(steps + 1):
        for j in range(i + 1):
            S = S0 * u**j * d ** (i - j)
            nodes[i][j] = Node(i, j, S, 0.0, payoff(S, K, option_type), path_count=math.comb(i, j),
                               probability=math.comb(i, j) * pi**j * (1 - pi) ** (i - j))
    for n in nodes[steps]:
        n.value = n.payoff
    for i in range(steps - 1, -1, -1):
        for j in range(i + 1):
            n, up, dn = nodes[i][j], nodes[i + 1][j + 1], nodes[i + 1][j]
            n.delta = (up.value - dn.value) / (up.spot - dn.spot)
            n.bond = (up.value - n.delta * up.spot) / R
            n.pi = pi
            cont = n.delta * n.spot + n.bond
            if american and n.payoff > cont + 1e-12:
                n.value, n.exercised = n.payoff, True
            else:
                n.value = cont
            # self-financing check: the hedge set here, carried to each child, is worth the child's value
            up.parent_portfolio_value = n.delta * up.spot + n.bond * R
            dn.parent_portfolio_value = n.delta * dn.spot + n.bond * R
    return ReplicationTree(S0, u, d, R, K, option_type, steps, american, pi, nodes)


@dataclass
class HedgeStep:
    step: int
    move: str | None          # "u" / "d" (None at t = 0)
    spot: float
    delta_before: float
    delta_after: float
    shares_traded: float      # + buy / - sell
    trade_cash: float         # cash paid (-) or received (+) for the shares
    cash_before: float        # bank account after interest, before rebalancing
    cash_after: float
    option_value: float
    hedge_value: float        # delta_after * S + cash_after


def market_maker(tree: ReplicationTree, path: str, ask: float) -> dict:
    """The dealer sells the option at `ask`, keeps the spread aside and runs the replicating hedge along `path`
    (a string of 'u' / 'd' of length `steps`). At maturity the hedge pays the option exactly."""
    if len(path) != tree.steps or set(path) - {"u", "d"}:
        raise ValueError("path must be a sequence of 'u' / 'd' of the tree length")
    root = tree.node(0, 0)
    steps = [HedgeStep(0, None, root.spot, 0.0, root.delta, root.delta, -root.delta * root.spot, root.value,
                       root.bond, root.value, root.value)]
    delta, cash, ups = root.delta, root.bond, 0
    for i, move in enumerate(path, start=1):
        ups += move == "u"
        n = tree.node(i, ups)
        cash_before = cash * tree.R
        new_delta = n.delta if n.delta is not None else delta     # at maturity: keep the position, settle
        traded = new_delta - delta
        trade_cash = -traded * n.spot
        cash = cash_before + trade_cash
        steps.append(HedgeStep(i, move, n.spot, delta, new_delta, traded, trade_cash, cash_before, cash, n.value,
                               new_delta * n.spot + cash))
        delta = new_delta
    final = tree.node(tree.steps, ups)
    hedge_final = steps[-1].hedge_value
    return {"path": path, "ask": ask, "price": tree.price, "spread_kept": ask - tree.price,
            "steps": [s.__dict__ for s in steps], "terminal_spot": final.spot, "liability": final.payoff,
            "hedge_value": hedge_final, "net": hedge_final - final.payoff}
