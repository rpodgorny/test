""" Helper functions and classes """
import json
import logging
import os
import random
import arrow
import time
from hashlib import sha256
from xml.etree import ElementTree

import dbf
from atxpylib.configparser import AtxConfigParser

from . import settings
from . import glo


def expand_user_or_none(path):
    """Syntactic sugar: returns expanded path or None if something fails
    Expanding path is used in DEV enviroment and for tests.
    However, for Asterix style production paths ("/atx300..." ) it is safe even on Windows,
    cause it changes path only if it begins with "~user"
    """
    try:
        return os.path.expanduser(path)
    except TypeError:
        pass


def error_response(txt):
    """Returns normalized error message (format understood by UX) to return from web endpoint"""
    return {"error": txt}


def message_response(txt):
    """Returns normalized  message (format understood by UX) to return from web endpoint"""
    return {"message": txt}


def archive_input_file(ffn):
    """Moves file to archive directory, returns new location
    Archive directory is just a subdirectory named 'archive' in the file's original directory
    """
    if not os.path.isfile(ffn):
        raise FileNotFoundError(ffn)

    dirname = asterixed_path(os.path.dirname(ffn), "archive")
    os.makedirs(dirname, exist_ok=True)
    new_ffn = asterixed_path(dirname, os.path.basename(ffn))
    os.replace(ffn, new_ffn)
    return new_ffn


def list_of_files(path):
    """Return list of full filenames (with path) found in path"""
    return [ffn for fn in os.listdir(path) if os.path.isfile(ffn := f"{path}/{fn}")]


def asterixed_path(*paths):
    """Works like os.path.join, but result conforms Asterix guidelines (reason: Windows compatibility):
    - no backslashes (converted to forward-slashes)
    """
    paths = [str(x).replace("\\", "/") for x in paths]
    return os.path.join(*paths).replace("\\", "/")


def random_string(length=None):
    """returns random string, 64 chars length (or shorter if wanted)"""
    seed = str(random.randint(0, 9999999))
    hash = sha256(seed.encode("utf-8")).hexdigest()
    return hash[:length] if length is not None else hash


def state_load(fn):
    """Returns JSON structure with 'state' data (serialized between program restarts)
    This function, along with state_save is intended to provide handy "one line" interface, so
    in case of problems, it simply log error message and return empty structure
    """
    try:
        with open(fn, "r") as f:
            return json.load(f)
    except FileNotFoundError:
        logging.warning(f"State file {fn} not found")
        return {}


def state_save(data, fn):
    """Writes JSON structure with 'state' data.
    Written to provide "one line" interface, so it also creates directories if necessary.
    """
    os.makedirs(os.path.dirname(fn), exist_ok=True)
    with open(fn, "w") as f:
        f.write(json.dumps(data, indent=4))


def read_temperature(thermometer_ini_fn):
    """Returns temperature in Celsius read from Asterix application 'thermometer',
    or None if information is unavailable or too old
    """
    if not os.path.isfile(thermometer_ini_fn):
        logging.warning(f"{thermometer_ini_fn} does not exists")
    ini = AtxConfigParser(thermometer_ini_fn)
    thermo_fn = ini.get("General", "OutFile", fallback=None)
    if not thermo_fn:
        logging.warning("Current temperature file not found")
        return
    if not os.path.isfile(thermo_fn):
        logging.warning(f"{thermo_fn} (as specified in {thermometer_ini_fn}) does not exists")
    ini = AtxConfigParser(thermo_fn)
    try:
        temperature_t = arrow.get(ini.get("Temperature", "Date", fallback=None), tzinfo=settings.TIMEZONE).timestamp()
    except TypeError:
        logging.warning(f"Temperature information in {thermo_fn} was not found")
        return
    temperature_age = time.time() - temperature_t
    if temperature_age > settings.TEMPERATURE_AGE_THRESHOLD:
        logging.warning(f"Temperature age {int(temperature_age)} sec is older than threshold {settings.TEMPERATURE_AGE_THRESHOLD} sec, ignoring it")
        return
    ret = ini.get("Temperature", "Celsius", fallback=None)
    try:
        ret = float(ret)
    except ValueError:
        logging.warning(f"Temperature value '{ret}' can't be converted to float, ignoring it")
        return
    logging.info(f"Temperature is {ret} (information {temperature_age} seconds old), read from file {thermo_fn}")
    return ret


def human_datetime(t, format=None):
    """Returns human-readable format of t, as used across Asterix products. For t==None returns empty string"""
    return arrow.get(t).to(settings.TIMEZONE).format(format or "YYYY-MM-DD HH:mm:ss") if t else ""


def human_time(t):
    """Returns human-readable format of t, as used across Asterix products. For t==None returns empty string"""
    return arrow.get(t).to(settings.TIMEZONE).format("HH:mm:ss") if t else ""


class DBFReader:
    """ Helper context manager for DBF imports.
        It just makes sure the DBF file gets closed no matter what.
    """

    def __init__(self, fn):
        self.fn = fn
        self.f = None

    def __enter__(self):
        self.f = dbf.Table(self.fn).open()
        return self.f

    def __exit__(self, *exc_info):
        if self.f:
            self.f.close()


def custom_template_fn(fn):
    """ Returns filename of template, based on configuration: preferably existing <fn> from custom template directory,
        fallbacks to <fn> in standard template directory
        All files must be based in settings.TEMPLATE_FOLDER directory,
        but the path is returned without that directory (because of Flask)
        TODO QUE This feature seems obsolete now. Instead, we use delivery_sheet_template_fn, and it seems to be good enough. Delete or not?
    """
    custom_fn = glo.setup.get("templates_directory", "") + "/" + fn
    return custom_fn if os.path.isfile(os.path.join(settings.TEMPLATE_FOLDER, custom_fn)) else ("printouts/" + fn)


def is_fn_temporary(fn):
    bn = os.path.basename(fn)
    return bn.startswith("_") \
        or bn.endswith("_") \
        or bn.endswith(".wrk") \
        or bn.split(".")[-1].startswith("_")  # "*._*"


def parse_ares_xml(s):
    prefix_map = {
        "are": "http://wwwinfo.mfcr.cz/ares/xml_doc/schemas/ares/ares_answer/v_1.0.1",
        "dtt": "http://wwwinfo.mfcr.cz/ares/xml_doc/schemas/ares/ares_datatypes/v_1.0.4",
    }
    tree = ElementTree.fromstring(s)
    nazev_ulice = tree.findtext(".//dtt:Nazev_ulice", None, prefix_map)
    cislo_domovni = tree.findtext(".//dtt:Cislo_domovni", None, prefix_map)
    cislo_orientacni = tree.findtext(".//dtt:Cislo_orientacni", None, prefix_map)
    address = f"{nazev_ulice} {cislo_domovni}" if (nazev_ulice and cislo_domovni) else None
    if cislo_orientacni and address:
        address += f"/{cislo_orientacni}"

    return {
        "name": tree.findtext(".//are:Obchodni_firma", None, prefix_map),
        "zip": tree.findtext(".//dtt:PSC", None, prefix_map),
        "city": tree.findtext(".//dtt:Nazev_obce", None, prefix_map),
        "address": address,
    }
