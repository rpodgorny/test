""" Project settings """
import os
import sys

DEFAULT_LANGUAGE = "cs"

# pause in seconds between checks for new data in input folder
SLEEP_INTERVAL = 1

SERVER_PORT = 7781

# communication with other modules
INPUT_PATH = "/atx300/comm/man_dis/"
OUTPUT_PATH = "/atx300/comm/dis_man/"
MATERIAL_INI_FILE = "/atx300/comm/material/material.ini"
THERMOMETER_INI_FILE = "/atx300/conf/thermometer.ini"
DB_BACKUP_PATH = "/atx300/history/dispatch/"

# Temperature date read from thermometer application is compared with current date
# older records than this treshold (in seconds) are ignored - propably thermometer is not running correctly
TEMPERATURE_AGE_THRESHOLD = 3600

# Those values limit the temperature range user can enter when creating an order. Both limits are exclusive
TEMPERATURE_USER_MIN = -50
TEMPERATURE_USER_MAX = 60

# Limit (in seconds) for age of orders displayed on 'Expeditions' page. Displayed are only younger orders.
EXP_PAGE_ORDERS_MAX_AGE = 24 * 60 * 60

LOG_FILE = "/atx300/log/dispatch.log"

DEFAULT_DB_FILE = "/atx300/data/dispatch.sqlite3"

# File with configuration of modules. See manual.txt for details
CONFIG_FILE = "/atx300/conf/dispatch.hjson"

# This password is used for managing users in DB
MASTER_PASSWORD_HASH = "02d7ac919990918b0e10e66108b82a68cf43d56ff56959bf38fbf4f5a5792ffe"

# "state" variables are serialized into this file
STATE_FILE = "/atx300/state/dispatch.json"

# This is local timezone. HACK: We have problem with arrow.to(local) so it is hardcoded
TIMEZONE = "Europe/Prague"

# This suffix is added to every imported file or folder, to prevent importing it again
IMPORTED_SUFFIX = "_imported"

# TODO REF: factor this out to some common utils
_basedir = os.path.dirname(sys.executable if getattr(sys, "frozen", False) else __file__)

TEMPLATE_FOLDER = os.path.join(_basedir, "templates")
STATIC_FOLDER = os.path.join(_basedir, "static")  # static files are served from there
