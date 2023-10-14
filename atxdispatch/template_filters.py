""" Definition of custom filters to be used in templates.
    They are registered (thus available in templates) under the same name as function name

    Mustache syntax is {{ something | filter_name }} or {{ something | filter_name(some_param) }}

"""
import arrow

from . import glo
from .import model, settings


def hide_none(x):
    """Custom filter to hide "none" values in templates."""
    return x or ""


def round_me(s, precision):
    """Custom filter to use in templates."""
    try:
        return round(float(s), int(precision))
    except (TypeError, ValueError):
        return s


def round_default(s):
    """Template filter, formats <s> to precision set in config.hjson."""
    try:
        return '{0:.{1}f}'.format(s, glo.setup["rounding_precision"])
    except (TypeError, ValueError):
        return s


def with_vat(s, rate):
    """Custom template filter to calculate price with VAT from price."""
    try:
        return float(s) * (100 + int(rate)) / 100
    except (TypeError, ValueError):
        return s


def vat(s, rate):
    """Custom template filter to calculate VAT from price."""
    try:
        return float(s) * int(rate) / 100
    except (TypeError, ValueError):
        return None


def customized_timestamp(value):
    """Converts timestamp in <value> to format set in models.Setup"""
    formatter = model.Setup.singleton().datetime_format or "YYYY-MM-DD HH:mm:ss"
    return arrow.get(value).to(settings.TIMEZONE).format(formatter) if value else ""
