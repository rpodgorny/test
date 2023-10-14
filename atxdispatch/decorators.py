""" Custom collection of decorators, mostly for endpoints (web.py) """

import time
import functools
import flask
import logging

from .func import error_response
from . import glo
from . import model
from .exceptions import UserInputError


def delayed(f):
    """For DEV purposes. Adds artificial delay to endpoint. Do not forget it in production!"""
    @functools.wraps(f)
    def wrap(*args, **kwargs):
        DELAY = 1.5
        time.sleep(DELAY)
        logging.warning(f"API endpoint {f} artificially delayed by {DELAY} sec, are you in DEV environment?")
        return f(*args, **kwargs)
    return wrap


def handle_errors(f):
    """For API endpoints. Catches exceptions and returns them in a JSON format used
       by UX script in order to display server error.
       Errors (except UserInputError) are also logged, with full stack.
    """
    @functools.wraps(f)
    def wrap(*args, **kwargs):
        try:
            return f(*args, **kwargs)
        except UserInputError as e:
            return error_response(str(e))
        except Exception as e:
            logging.exception(f"exception when calling {f.__name__}")
            return error_response(str(e))
    return wrap


def login_required(f):
    @functools.wraps(f)
    def wrap(*args, **kwargs):
        login_module = glo.setup.get("module_login", False)
        if login_module and not flask.session.get("logged_in", False):
            return flask.Response("Login required", status=401)
        return f(*args, **kwargs)
    return wrap


def superuser_required(f):
    """For endpoints - kicks off anyone without can_edit_users privilege"""
    @functools.wraps(f)
    def wrap(*args, **kwargs):
        if not flask.session.get("logged_in", False) or not flask.session.get("can_edit_users", False):
            return flask.Response("Need superuser privileges", status=401)
        return f(*args, **kwargs)
    return wrap


def table_locked_response(table_name):
    """ Returns standard error response with proper message"""
    return error_response(f"User '{flask.session.get('username')}' can't write into table '{table_name}'")


def is_table_locked(table_name):
    """ Returns True, if if logged-in user has table_name in his/her locked_tables"""
    logged_in_user = flask.session.get("username")  # we can find user by name, because it is unique
    if logged_in_user:
        locked_tables = [x.table_name for x in model.User.get(username=logged_in_user).locked_tables]
        return table_name in locked_tables


def guard_table_lock(table_name):
    """ Decorator: disallow writing into table_name, if logged-in user has table_name in his/her locked_tables
        Note: "double wrap" is necessary when writing decorator accepting parameters, nice resume here: https://stackoverflow.com/a/10176276
    """
    def my_decorator(f):
        @functools.wraps(f)
        def wrapper(*args, **kwargs):
            if is_table_locked(table_name):
                return table_locked_response(table_name)
            return f(*args, **kwargs)
        return wrapper
    return my_decorator
