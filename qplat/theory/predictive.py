"""Predictive regressions and the Stambaugh (1999) bias.

The system (one period = one observation step):
    r_{t+1} = alpha + beta x_t + u_{t+1}          (return on a lagged predictor)
    x_{t+1} = mu    + rho  x_t + v_{t+1}          (the predictor is a persistent AR(1))
with Cov(u, v) = sigma_uv. The OLS slope rho_hat is biased downwards (Kendall: E[rho_hat - rho] ~ -(1 + 3 rho) / n)
and, because u and v are correlated, that error leaks into beta_hat:
    E[beta_hat - beta] = gamma E[rho_hat - rho],   gamma = sigma_uv / sigma_v^2.
With a valuation ratio (dividend yield) rho is close to 1 and corr(u, v) close to -1: a price rise lowers D/P
and raises the return in the same month, so gamma < 0 and beta_hat is biased upwards, towards "predictability".

Continuous-time origin: a stock with a mean-reverting expected return,
    d ln X = (a + b Y - sigma_X^2 / 2) dt + sigma_X dB^X,   dY = theta (Ybar - Y) dt + sigma_Y dB^Y,
sampled every dt, is exactly this system (see continuous_to_discrete).

Corrections: Stambaugh's first-order bias adjustment, and the reduced-bias augmented regression of
Amihud & Hurvich (2004), which comes with a usable standard error.
"""

from __future__ import annotations

import math

import numpy as np


# ----------------------------------------------------------------------------- continuous time -> discrete system

def continuous_to_discrete(a: float, b: float, sigma_x: float, theta: float, y_bar: float, sigma_y: float,
                           corr: float, dt: float) -> dict:
    """Exact sampling of the GBM with an Ornstein-Uhlenbeck drift. Over [t, t + dt]:
        ln X_{t+dt} - ln X_t = (a - sigma_X^2 / 2) dt + b int Y du + sigma_X dB^X,
        int_t^{t+dt} Y du = Ybar dt + (Y_t - Ybar) B(dt) + sigma_Y int B(t + dt - s) dB^Y_s,   B(s) = (1 - e^{-theta s}) / theta.
    So beta = b B(dt), rho = e^{-theta dt}, and the two innovations share the Brownian increments of Y."""
    rho = math.exp(-theta * dt)
    B = (1.0 - rho) / theta
    B2 = (1.0 - rho * rho) / (2.0 * theta)
    int_B = (dt - B) / theta                         # int_0^dt B(s) ds
    int_B2 = (dt - 2.0 * B + B2) / theta ** 2        # int_0^dt B(s)^2 ds
    int_Be = (B - B2) / theta                        # int_0^dt B(s) e^{-theta s} ds
    var_v = sigma_y ** 2 * B2
    var_u = b * b * sigma_y ** 2 * int_B2 + sigma_x ** 2 * dt + 2.0 * b * corr * sigma_x * sigma_y * int_B
    cov_uv = b * sigma_y ** 2 * int_Be + corr * sigma_x * sigma_y * B
    return {"alpha": (a - 0.5 * sigma_x ** 2) * dt + b * y_bar * (dt - B), "beta": b * B,
            "mu": y_bar * (1.0 - rho), "rho": rho, "sigma_u": math.sqrt(var_u), "sigma_v": math.sqrt(var_v),
            "corr_uv": cov_uv / math.sqrt(var_u * var_v), "gamma": cov_uv / var_v}


# ----------------------------------------------------------------------------- estimation on one sample

def kendall_bias(rho: float, n: int) -> float:
    return -(1.0 + 3.0 * rho) / n


def amihud_hurvich_rho(rho_hat: float, n: int) -> float:
    """Second-order reduced-bias AR(1) slope, kept just below one."""
    return min(rho_hat + (1.0 + 3.0 * rho_hat) / n + 3.0 * (1.0 + 3.0 * rho_hat) / n ** 2, 0.9999)


def _fit_line(x: np.ndarray, y: np.ndarray):
    xm, ym = x.mean(), y.mean()
    sxx = float(((x - xm) ** 2).sum())
    slope = float(((x - xm) * (y - ym)).sum() / sxx)
    icpt = float(ym - slope * xm)
    resid = y - icpt - slope * x
    s2 = float(resid @ resid / (len(x) - 2))
    return icpt, slope, math.sqrt(s2 / sxx), resid, s2


def predictive_regression(r_next, x_now, x_next) -> dict:
    """OLS of r_{t+1} on x_t, AR(1) of the predictor, Stambaugh's bias and the Amihud-Hurvich correction.
    The three arrays are aligned triples (r_{t+1}, x_t, x_{t+1})."""
    r, x, xn = (np.asarray(a, dtype=float) for a in (r_next, x_now, x_next))
    ok = np.isfinite(r) & np.isfinite(x) & np.isfinite(xn)
    r, x, xn = r[ok], x[ok], xn[ok]
    n = len(r)
    if n < 10:
        raise ValueError("échantillon trop court pour la régression prédictive")
    alpha, beta, se_beta, u, s2u = _fit_line(x, r)
    mu, rho, se_rho, v, s2v = _fit_line(x, xn)
    cov_uv = float(u @ v / (n - 2))
    gamma = cov_uv / s2v
    corr = cov_uv / math.sqrt(s2u * s2v)
    bias = gamma * kendall_bias(rho, n)                       # estimated E[beta_hat - beta]

    # Amihud & Hurvich (2004): corrected AR residuals as a second regressor
    rho_c = amihud_hurvich_rho(rho, n)
    mu_c = float(xn.mean() - rho_c * x.mean())
    v_c = xn - mu_c - rho_c * x
    X = np.column_stack([np.ones(n), x, v_c])
    coef, *_ = np.linalg.lstsq(X, r, rcond=None)
    e = r - X @ coef
    cov = float(e @ e / (n - 3)) * np.linalg.inv(X.T @ X)
    phi = float(coef[2])
    se_c = math.sqrt(float(cov[1, 1]) + phi ** 2 * (1.0 + 3.0 / n + 9.0 / n ** 2) ** 2 * se_rho ** 2)
    return {
        "n": n, "alpha": alpha, "beta": beta, "se_beta": se_beta, "t": beta / se_beta,
        "r2": 1.0 - float(u @ u) / float(((r - r.mean()) ** 2).sum()),
        "mu": mu, "rho": rho, "se_rho": se_rho, "half_life": (math.log(0.5) / math.log(rho)) if 0 < rho < 1 else None,
        "sigma_u": math.sqrt(s2u), "sigma_v": math.sqrt(s2v), "corr_uv": corr, "gamma": gamma,
        "rho_bias": kendall_bias(rho, n), "beta_bias": bias, "beta_stambaugh": beta - bias,
        "rho_ah": rho_c, "beta_ah": float(coef[1]), "se_ah": se_c, "t_ah": float(coef[1]) / se_c, "phi_ah": phi,
    }


def bootstrap_null(r_next, x_now, x_next, n_boot: int = 2000, seed: int = 0) -> dict:
    """Distribution of beta_hat and of its t-stat when returns are NOT predictable: the predictor follows its
    bias-corrected AR(1), returns are their mean plus resampled residuals, the (u, v) pairs drawn together so
    their correlation, the source of the bias, is kept. Returns one-sided and two-sided bootstrap p-values."""
    est = predictive_regression(r_next, x_now, x_next)
    r, x, xn = (np.asarray(a, dtype=float) for a in (r_next, x_now, x_next))
    ok = np.isfinite(r) & np.isfinite(x) & np.isfinite(xn)
    r, x, xn = r[ok], x[ok], xn[ok]
    n = len(r)
    u = r - est["alpha"] - est["beta"] * x
    v = xn - est["mu"] - est["rho"] * x
    rho_c = est["rho_ah"]
    mu_c = float(xn.mean() - rho_c * x.mean())
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, n, size=(n_boot, n))
    us, vs = u[idx], v[idx]
    xs = np.empty((n_boot, n + 1))
    xs[:, 0] = x[0]
    for t in range(n):
        xs[:, t + 1] = mu_c + rho_c * xs[:, t] + vs[:, t]
    rs = r.mean() + us
    b, se, _ = _batch_ols(xs[:, :-1], rs)
    t_stat = b / se
    return {
        "n_boot": n_boot, "beta": est["beta"], "t": est["t"],
        "p_one_sided": float((b >= est["beta"]).mean()), "p_two_sided": float((np.abs(t_stat) >= abs(est["t"])).mean()),
        "beta_null_mean": float(b.mean()), "beta_null_q05": float(np.quantile(b, 0.05)),
        "beta_null_q95": float(np.quantile(b, 0.95)), "t_crit_95": float(np.quantile(t_stat, 0.95)),
        "beta_samples": b, "t_samples": t_stat,
    }


# ----------------------------------------------------------------------------- Monte Carlo of the estimators

def _batch_ols(x: np.ndarray, y: np.ndarray):
    """Row-wise OLS of y on x with a constant: slopes, standard errors, residuals (arrays of shape (S, n))."""
    xm, ym = x.mean(axis=1, keepdims=True), y.mean(axis=1, keepdims=True)
    dx, dy = x - xm, y - ym
    sxx = (dx * dx).sum(axis=1)
    slope = (dx * dy).sum(axis=1) / sxx
    resid = dy - slope[:, None] * dx
    s2 = (resid * resid).sum(axis=1) / (x.shape[1] - 2)
    return slope, np.sqrt(s2 / sxx), resid


def simulate_system(rho: float, corr: float, n: int, beta: float = 0.0, n_sims: int = 2000, seed: int = 0):
    """n_sims samples of n triples (r_{t+1}, x_t, x_{t+1}), unit innovation variances, x started from its
    stationary law: returns (r, x_now, x_next), each (n_sims, n)."""
    rng = np.random.default_rng(seed)
    z1, z2 = rng.standard_normal((2, n_sims, n))
    v = z1
    u = corr * z1 + math.sqrt(1.0 - corr * corr) * z2
    x = np.empty((n_sims, n + 1))
    x[:, 0] = rng.standard_normal(n_sims) / math.sqrt(1.0 - rho * rho)
    for t in range(n):
        x[:, t + 1] = rho * x[:, t] + v[:, t]
    return beta * x[:, :-1] + u, x[:, :-1], x[:, 1:]


def estimator_study(rho: float, corr: float, n: int, beta: float = 0.0, n_sims: int = 2000, seed: int = 0) -> dict:
    """What the OLS predictive regression does when the truth is known: bias of beta_hat against Stambaugh's
    formula, size of the t-test (how often a useless predictor looks significant), and the Amihud-Hurvich fix.
    Units: innovations of unit variance, so beta is in sigma_u / sigma_v and gamma = corr."""
    r, x, xn = simulate_system(rho, corr, n, beta, n_sims, seed)
    b, se_b, _ = _batch_ols(x, r)
    t_ols = (b - beta) / se_b
    rho_hat, _, v = _batch_ols(x, xn)
    # standard error of rho_hat, then the augmented regression row by row (2 regressors after demeaning)
    dx = x - x.mean(axis=1, keepdims=True)
    sxx = (dx * dx).sum(axis=1)
    se_rho = np.sqrt((v * v).sum(axis=1) / (n - 2) / sxx)
    rho_c = np.minimum(rho_hat + (1 + 3 * rho_hat) / n + 3 * (1 + 3 * rho_hat) / n ** 2, 0.9999)
    vc = xn - rho_c[:, None] * x
    vc -= vc.mean(axis=1, keepdims=True)
    dr = r - r.mean(axis=1, keepdims=True)
    sxv = (dx * vc).sum(axis=1)
    svv = (vc * vc).sum(axis=1)
    det = sxx * svv - sxv ** 2
    sxr, svr = (dx * dr).sum(axis=1), (vc * dr).sum(axis=1)
    b_ah = (svv * sxr - sxv * svr) / det
    phi = (sxx * svr - sxv * sxr) / det
    e = dr - b_ah[:, None] * dx - phi[:, None] * vc
    s2 = (e * e).sum(axis=1) / (n - 3)
    se_ah = np.sqrt(s2 * svv / det + phi ** 2 * (1 + 3 / n + 9 / n ** 2) ** 2 * se_rho ** 2)
    t_ah = (b_ah - beta) / se_ah

    gamma = corr                                             # sigma_uv / sigma_v^2 with unit variances
    return {
        "rho": rho, "corr": corr, "n": n, "beta": beta, "n_sims": n_sims, "gamma": gamma,
        "rho_hat_mean": float(rho_hat.mean()), "rho_bias": float(rho_hat.mean() - rho), "rho_bias_kendall": kendall_bias(rho, n),
        "beta_hat_mean": float(b.mean()), "beta_bias": float(b.mean() - beta),
        "beta_bias_stambaugh": gamma * kendall_bias(rho, n),
        "beta_hat_sd": float(b.std()), "beta_ah_mean": float(b_ah.mean()), "beta_ah_sd": float(b_ah.std()),
        "size_ols_one_sided": float((t_ols > 1.645).mean()) if gamma <= 0 else float((t_ols < -1.645).mean()),
        "size_ols_two_sided": float((np.abs(t_ols) > 1.96).mean()),
        "size_ah_one_sided": float((t_ah > 1.645).mean()) if gamma <= 0 else float((t_ah < -1.645).mean()),
        "size_ah_two_sided": float((np.abs(t_ah) > 1.96).mean()),
        "t_ols_mean": float(t_ols.mean()), "t_ols_q95": float(np.quantile(t_ols, 0.95)),
        "samples": {"beta_hat": b, "beta_ah": b_ah, "t_ols": t_ols, "t_ah": t_ah, "rho_err": rho_hat - rho},
    }
