""" Data model

    Note: SQLite does not constraint numbers, you can easily store "foo" in integer field.
    To prevent this and raise error on "almost" database level, we use custom Strict* fields.

    Data validation is handled by custom <model>.save() method (see Material, for example)
    But this kind of implementation is pretty much naive. Better way is field validation,
    however this is more complex task with new libraries involved.
    (or use something like constraints=[Check('price > 0')],
    see http://docs.peewee-orm.com/en/latest/peewee/models.html

    We do not use STRICT pragma on entire database, because it makes things
    pretty complicated with Date / Time fields
    (most propably is not issue, because we use timestamp internally now, However, needs testing)
"""
# TODO NTH: use strict pragma. WAIT until Windows have Python 3.11

import os
import time
import logging
from decimal import Decimal, ROUND_HALF_UP
from . import settings
import arrow
from hashlib import sha256
from peewee import (
    AutoField,
    BooleanField,
    DoesNotExist,
    ForeignKeyField,
    IntegrityError,
    Model,
    SqliteDatabase,
    TextField,
)
from peewee_migrate import Router

from . import glo
from .func import expand_user_or_none
from . import func
from .model_fields import StrictDoubleField, StrictIntegerField, TimestampField, EnumField, RegistrationNumberField, StrippedTextField


# List of model names supporting universal endpoints for 'select/detail' queries
SD_TABLES = ["Order", "PumpOrder", "Material", "Recipe", "Defaults", "Car", "Pump", "Driver", "ConstructionSite", "Customer", "Contract", "Sample", "Batch", "Delivery", "PumpSurcharge", "TransportZone", "CompanySurcharge", "Price", "TransportType", "User"]

# List of model names supporting universal endpoints for 'delete' queries
DEL_TABLES = ["Order", "Material", "Recipe", "Defaults", "Car", "Pump", "Driver", "ConstructionSite", "Customer", "Contract", "PumpSurcharge", "TransportZone", "CompanySurcharge", "Price", "TransportType", "LockedTable"]

# List of model names supporting universal endpoints for 'add/update' queries.
AU_TABLES = ["PumpOrder", "Material", "Defaults", "Car", "Pump", "Driver", "ConstructionSite", "Customer", "Contract", "PumpSurcharge", "TransportZone", "CompanySurcharge", "Price", "TransportType", "LockedTable"]

# Singleton - database connection. Initialized at runtime via mount_db
db = SqliteDatabase(None)

# Change loging level to INFO to avoid logging every query in DEV enviroment
logger = logging.getLogger("peewee")
logger.addHandler(logging.StreamHandler())
logger.setLevel(logging.INFO)

PAYMENT_CASH = 0
PAYMENT_INVOICE = 1
PAYMENT_CREDIT = 2
PAYMENT_CARD = 3

PAYMENT_TYPE_NAMES = {
    PAYMENT_CASH: "Cash",
    PAYMENT_INVOICE: "Invoice",
    PAYMENT_CREDIT: "Credit",
    PAYMENT_CARD: "Card",
}

# Price types to be used in Surcharges
SURCHARGE_PRICE_FIXED = 0
SURCHARGE_PRICE_PER_CUBIC_METER = 1
SURCHARGE_PRICE_PER_OTHER_UNIT = 2


def with_vat(value):
    # TODO REF: duplicate code with web.with_vat. Can't use this function in model.py due to circular import
    try:
        return value * (1 + Setup.singleton().vat_rate / 100)
    except TypeError:
        return value  # vat_rate not set


def db_file(path=None):
    """Returns fully qualified path to database file,
    either <path> or default.
    At any condition, returns something interpretable as path
    """
    return expand_user_or_none(path) or settings.DEFAULT_DB_FILE


def mount_db(db_file):
    """Mounts database to model
    This is pretty complex function with plenty of side effects:
    creates db file and even a path to it, and exits program if something fails.
    """
    global db

    logging.info(f"Using db file {db_file}")

    # Ensure the path exists
    if db_file != ":memory:":
        os.makedirs(os.path.dirname(db_file), exist_ok=True)

    # SQLite by default reuses auto increment field after delete, pragma "foreign_keys" avoids this
    # check_same_thread solves threading problem
    db.init(db_file, pragmas=[("foreign_keys", "on")], check_same_thread=False)

    # Test connection - it should fail here, if something is wrong
    db.connect()

    logging.info(f"DB Pragma cache_size: {db.cache_size}")
    logging.info(f"DB Pragma journal_mode: {db.journal_mode}")
    logging.info(f"DB Pragma journal_size_limit: {db.journal_size_limit}")
    logging.info(f"DB Pragma page_size: {db.page_size}")


def mount_and_migrate_db(db_fn):
    database_exists = os.path.isfile(db_fn)

    mount_db(db_fn)

    if not database_exists:
        logging.warning(f"DB file {db_fn} does not exist, performing auto initialization")

    logging.info("will run db migrations")
    router = Router(SqliteDatabase(db_fn))
    router.run()


class BaseModel(Model):
    class Meta:
        database = db
        # TODO: enable this and handle migration somehow
        # This can switch on "STRICT" in table definition.
        # However, it works only with SQLite3 version 3.37 and above (according to documentation)
        # thus, has conflict with existing Asterix installations. So I keep it switched off for now.
        # this has been supposedly added in python 3.11 (for windows)
        # https://docs.python.org/3/whatsnew/changelog.html
        # strict_tables = True

    def as_json(self):
        """Returns database fields as JSON serializable hashtable
        For all TimestampField is also added a human representation (with suffix '_human')
        TODO REF NTH - this _human thing is also handled by _human properties in particular models, so here is most propably obsolete
            Should be left only in models, because as_json properties are not available in printouts
        """
        ret = self.__data__
        for field_name, field in self._meta.fields.items():
            if isinstance(field, TimestampField):
                ret[f"{field_name}_human"] = func.human_datetime(ret[field_name], Setup.singleton().datetime_format)
        return ret

    def as_endpoint(self):
        """ Returns JSON structure that are propagated to frontend endpoint.
            Mostly they are just as_json data, but some models add or hide additional information.
            The intention is not to create separate endpoint for each data, but put this logic
            into model itself and use one universal endpoint /detail/<model_name> (see web.py)
        """
        return self.as_json()

    def update_from_json(self, json_data):
        """Updates internal data from json. Keys in json are model field names."""
        for k, v in json_data.items():
            if k in self._meta.fields.keys():
                # When Peewee ORM raises IntegrityError (referencing nonexisting record),
                # it does not show which ForeignKey actually failed.
                # But we need to display this information to user, so we check it manually,
                # although it's duplicity with DB internal checks.
                if isinstance(self._meta.fields[k], ForeignKeyField) and v:
                    try:
                        self._meta.fields[k].rel_model.get_by_id(v)
                    except DoesNotExist:
                        raise IntegrityError(f"Referenced record {self.__class__.__name__}.{k}[{v}] does not exist in DB")

                if k != "id":  # rewriting id produces unexpected results when creating new items
                    setattr(self, k, v)
            else:
                raise KeyError(f"Field {k} does not exist in {self.__class__.__name__}")
        self.save()
        return self

    @classmethod
    def delete_record(cls, record_id):
        """Deletes instance of record identified by id
        Returns None on success, error message otherwise
        """
        try:
            record = cls.get_by_id(record_id)
        except DoesNotExist:
            return f"{cls.__name__}.{record_id} does not exist"

        try:
            record.delete_instance()
        except IntegrityError:
            return f"{cls.__name__}.{record_id} used somewhere, cannot be deleted"

    @classmethod
    def integrity_check(cls):
        """Check table integrity in a simple way: Try to re-save every record in the table.
           If there is a problem, custom save() method of derived class or constraint in custom db field
           throws an exception, which is logged.
           Returns success
        """
        errors = 0
        for record in cls.select():
            try:
                record.save()
            except:
                errors += 1
                logging.exception(f"Integrity check failed: {cls.__name__}.{record.id}")
        return errors == 0

    @classmethod
    def select_ordered(cls, order_by):
        """ Returns cls.select().order_by(foo), where 'foo' is constructed from parameter
            order_by, which is in "endpoint format", e.g. column name optionally prefixed with "!"
            order_by can be empty or None
            Raises AttributeError, if order_by column does not exists or is not "orderable by"
        """
        dataset = cls.select()
        if order_by:
            order_reversed = order_by.startswith("!")
            order_field = getattr(cls, order_by[1:] if order_reversed else order_by)

            if isinstance(order_field, property):  # not a great style, but it shouldn't bite us back
                raise AttributeError(f"Can't order by property '{order_by}'")

            if order_reversed:
                order_field = order_field.desc()
            dataset = dataset.order_by(order_field)
        return dataset


class HiddeableModel(BaseModel):
    """Table, where record is hideable - contains 'hidden' field"""

    hidden = BooleanField(default=False)

    def toggle_hidden(self):
        """Toggles hidden flag, returns model (to support 'chain' syntax)"""
        self.hidden = not self.hidden
        return self


class AuditedModel(BaseModel):
    """Table, where records are audited - contain fields about who and when modified it"""

    # Contains username of logged-in user
    # It is not foreign key to Users, because we need to preserve value in moment of order
    audit_changed_by = StrippedTextField(null=True)
    audit_changed_at = TimestampField(default=0)

    def write_audit_info(self, username):
        self.audit_changed_by = username
        self.audit_changed_at = TimestampField.now()


class Material(BaseModel):
    ALLOWED_TYPES = ["Admixture", "Aggregate", "Cement", "Water", "Addition"]

    type = TextField()  # does not need to be StrippedTextField, because it's limited to ALLOWED_TYPES in self.save()
    name = StrippedTextField(unique=True)
    long_name = StrippedTextField(null=True, unique=True)
    unit = StrippedTextField(null=True)
    comment = StrippedTextField(null=True)

    def as_ini_section(self):
        """Returns hashtable in format used in Asterix material.ini files"""
        return {
            "id": self.id,  # this is optional
            "Type": self.type,  # this is optional
            "Name": self.name,
            "LongName": self.long_name,
        }

    @classmethod
    def delete_record(cls, record_id):
        """Deletes record and updates inifile with materials. Errors in INI file creation are logged"""
        ret = super(cls, cls).delete_record(record_id)
        glo.export_material_ini = 1
        return ret

    def update_from_json(self, json_data):
        """Updates record and inifile with materials. Errors in INI file creation are logged"""
        ret = super().update_from_json(json_data)
        glo.export_material_ini = 1
        return ret

    def get_consumptions(self, from_t, to_t):
        """Returns tuple with consumptions of that material within given date range: from recipe, requested, real
        Consumptions are taken from model OrderMaterial, linked to Material (this model) by "name" field
        """
        amount_recipe = 0
        amount_rq = 0
        amount_e1 = 0
        order_materials = OrderMaterial.select().join(Order).where(Order.t.between(from_t, to_t)).filter(name=self.name)
        for order_material in order_materials:
            for bm in order_material.consumptions:
                amount_recipe += bm.amount_recipe
                amount_rq += bm.amount_rq
                amount_e1 += bm.amount_e1
        return amount_recipe, amount_rq, amount_e1

    def get_stock(self):
        """ Sum of all StockMovements related to this material."""
        return sum([x.amount for x in self.stock_movements])

    def get_stock_sums(self, from_t, to_t):
        """Returns tuple of (positive, negative) stock movements of that material within given date range
           Note: negative sum is negative number, e.g total=positive+negative
        """
        amount_positive = 0
        amount_negative = 0
        for x in self.stock_movements.where(StockMovement.t.between(from_t, to_t)):
            if x.amount > 0:
                amount_positive += x.amount
            else:
                amount_negative += x.amount
        return amount_positive, amount_negative

    def save(self, force_insert=False, only=None):
        """ Do not allow saving material of wrong type."""
        if self.type not in self.ALLOWED_TYPES:
            raise ValueError(f"Material type '{self.type}' not allowed, use one of [{', '.join(self.ALLOWED_TYPES)}]")
        return super().save(force_insert, only)

    def as_endpoint(self):
        data = self.as_json()
        data["type_str"] = "{%s}" % self.type
        return data


class StockMovement(BaseModel):
    """ Describes one movement in Material stock: typically when new material arrives or is consumed """
    material = ForeignKeyField(Material, backref="stock_movements", on_delete="CASCADE")
    amount = StrictDoubleField()  # how much material has been piled in. Can be negative as well (for stock corrections)
    t = TimestampField(default=TimestampField.now)
    comment = StrippedTextField(null=True)


class Defaults(BaseModel):
    name = StrippedTextField()
    batch_volume_limit = StrictDoubleField(null=True)
    lift_pour_duration = StrictDoubleField(null=True)
    lift_semi_pour_duration = StrictDoubleField(null=True)
    k_value = StrictDoubleField(null=True)
    k_ratio = StrictDoubleField(null=True)
    mixing_duration = StrictDoubleField(null=True)
    mixer_semi_opening_duration = StrictDoubleField(null=True)
    mixer_semi_opening2_duration = StrictDoubleField(null=True)
    mixer_opening_duration = StrictDoubleField(null=True)
    consistency_class = StrippedTextField(null=True)
    workability_time = StrictIntegerField(null=True)  # in minutes

    def save(self, force_insert=False, only=None):
        """ Do not allow saving negative values """
        for field in [
            self.batch_volume_limit,
            self.lift_pour_duration,
            self.lift_semi_pour_duration,
            self.k_value,
            self.k_ratio,
            self.mixing_duration,
            self.mixer_semi_opening_duration,
            self.mixer_semi_opening2_duration,
            self.mixer_opening_duration,
        ]:
            if field and float(field) < 0:
                raise ValueError("Defaults: negative value is not allowed")
        return super().save(force_insert, only)


class Recipe(BaseModel):
    name = StrippedTextField(unique=True)
    recipe_class = StrippedTextField(null=True)
    exposure_classes = StrippedTextField(null=True)
    description = StrippedTextField(null=True)  # recipe technological description
    comment = StrippedTextField(null=True)  # free comment, e.g. "only for customer X"
    consistency_class = StrippedTextField(null=True)
    batch_volume_limit = StrictDoubleField(null=True)
    lift_pour_duration = StrictDoubleField(null=True)
    lift_semi_pour_duration = StrictDoubleField(null=True)
    mixer_semi_opening_duration = StrictDoubleField(null=True)
    mixer_semi_opening2_duration = StrictDoubleField(null=True)
    mixer_opening_duration = StrictDoubleField(null=True)
    mixing_duration = StrictDoubleField(null=True)
    # TODO: add variant? QUE: stara poznamka. Zjistit zda jsou varianty receptu potreba
    workability_time = StrictIntegerField(null=True)  # in minutes - TODO REF: rename to duration?
    price = StrictDoubleField(null=True)  # per cubic meter, in abstract currency (program defines only currency symbol)

    # Those two fields has meaning ONLY for material of type "Addition"
    # both works as a recipe defaults, but can be modified for particular material in RecipeMaterial
    k_value = StrictDoubleField(null=True)  # This is accawr
    k_ratio = StrictDoubleField(null=True)

    # This field is something like 'short recipe name used by organization'
    # Typical values are "1", "1C" etc. The confusing name "number" is for legacy reasons,
    # but it IS TextField. Most accurate description of that field is probably "shorthand_name"
    # also, some other companies (zapa kdx, ...?) use this as primary key
    number = StrippedTextField(null=True, unique=True)

    d_max = StrictIntegerField(null=True)
    cl_content = StrictDoubleField(null=True)
    vc = StrictDoubleField(null=True)  # TODO REF: find a better name for this
    cement_min = StrictDoubleField(null=True)  # TODO REF: find a better name for this

    # we need to hold this relation to handle possible changes in Defaults appropriately
    defaults = ForeignKeyField(Defaults, null=True, backref="recipes", on_delete="SET NULL")

    def delete_materials(self):
        RecipeMaterial.delete().where(RecipeMaterial.recipe == self).execute()

    def get_or_create_production(self):
        """ Returns production bounded to that recipe. If does not exist, create it """
        try:
            return self.productions[0]
        except IndexError:
            return RecipeProduction.create(recipe=self)

    def _get_materials(self):
        ret = [x.as_json() for x in self.materials]
        if not ret:
            return []

        ret = sorted(ret, key=lambda d: d["sequence_number"])
        return [{k: v for k, v in d.items() if k != "sequence_number"} for d in ret]

    def as_json(self):
        """enhances standard as_json by production values, as they are separated to other model"""
        ret = super().as_json()
        ret["_production"] = self.get_or_create_production().as_json()
        ret["_materials"] = self._get_materials()
        return ret

    @db.atomic()
    def my_update(self, recipe_data):
        """ Updating recipe is pretty complex operation, involving other tables """

        materials = recipe_data.pop("materials")
        sample_period_days = recipe_data.pop("sample_period_days", None)
        sample_period_volume = recipe_data.pop("sample_period_volume", None)

        self.update_from_json(recipe_data)
        self.delete_materials()

        production = self.get_or_create_production()
        production.sample_period_days = sample_period_days
        production.sample_period_volume = sample_period_volume
        production.save()

        for material in materials:
            RecipeMaterial.create(
                recipe=self,
                material=Material.get_by_id(material.get("material")),
                amount=material.get("amount"),
                delay=material.get("delay"),
                k_value=material.get("k_value"),
                k_ratio=material.get("k_ratio"),
            )


class RecipeProduction(BaseModel):
    """ Holds information about production status of particular Recipe """
    recipe = ForeignKeyField(Recipe, backref="productions", unique=True, on_delete="CASCADE")

    # For 'take sample for test in lab' feature
    sample_period_days = StrictIntegerField(null=True)
    sample_period_volume = StrictDoubleField(null=True)
    sample_last_volume = StrictDoubleField(default=0)
    sample_last_t = TimestampField(default=0)

    # total volume of concrete made from this recipe,
    # number that was sent to manager. Cancelled orders ARE in that sum.
    volume_total = StrictDoubleField(default=0)

    def is_time_to_take_sample(self):
        """Returns if there is time to take sample."""
        if self.sample_period_volume and self.volume_total >= (self.sample_last_volume + self.sample_period_volume):
            return True
        if self.sample_period_days:
            today_t = time.time()
            sample_treshold_t = self.sample_last_t + self.sample_period_days * 3600 * 24
            if today_t >= sample_treshold_t:
                return True

    @db.atomic()
    def take_sample(self, username, comment):
        """Write down that we had taken a sample"""
        logging.info(f"Sample of {self.recipe.name} was taken by '{username}' at {self.volume_total} m3 of total production")
        self.sample_last_volume = self.volume_total
        self.sample_last_t = TimestampField.now()
        self.save()
        sample = Sample.create(recipe=self.recipe, volume_total=self.volume_total, comment=comment or None)
        sample.write_audit_info(username)
        sample.save()


class RecipeMaterial(BaseModel):
    """Many2Many relationship between Recipe and Material, with some additional attributes like 'amount'"""
    sequence_number = AutoField()
    recipe = ForeignKeyField(Recipe, backref="materials", on_delete="CASCADE")
    material = ForeignKeyField(Material, backref="recipes", on_delete="RESTRICT")
    amount = StrictDoubleField(null=True)
    delay = StrictDoubleField(null=True)

    k_value = StrictDoubleField(null=True)  # Named "ACCAWR" in .ORD files
    k_ratio = StrictDoubleField(null=True)

    def save(self, force_insert=False, only=None):
        """ Constraint: Do not allow k_value and k_ratio for other materials than Addition."""
        if self.k_value or self.k_ratio:
            if self.material.type != "Addition":
                raise ValueError("Cannot set k_value or k_ratio for RecipeMaterial, which is not of type 'Addition'")
        return super().save(force_insert, only)


class Sample(AuditedModel):
    """Database of samples for lab"""

    recipe = ForeignKeyField(Recipe, backref="samples", on_delete="RESTRICT")
    t = TimestampField(default=TimestampField.now)
    volume_total = StrictDoubleField(default=0)  # Meaning "at what total volume of Recipe production was sample taken?
    comment = StrippedTextField(null=True)

    def as_endpoint(self):
        data = self.as_json()
        data["recipe_name"] = self.recipe.name if self.recipe else ""
        return data


class Customer(HiddeableModel):
    name = StrippedTextField()
    address = StrippedTextField(null=True)
    city = StrippedTextField(null=True)
    zip = StrippedTextField(null=True)
    phone = StrippedTextField(null=True)
    fax = StrippedTextField(null=True)
    email = StrippedTextField(null=True)
    company_idnum = StrippedTextField(null=True)  # ICO. Deliberately not unique, due to company branches and facilities
    vat_idnum = StrippedTextField(null=True)  # DIC
    payment_type = EnumField(allowed_values=PAYMENT_TYPE_NAMES.keys(), default=PAYMENT_CASH, null=True)
    comment = StrippedTextField(null=True)

    class Meta:
        indexes = (
            (('name', 'company_idnum'), True),
        )


class ConstructionSite(HiddeableModel):
    name = StrippedTextField(unique=True)
    address = StrippedTextField(null=True)
    city = StrippedTextField(null=True)
    zip = StrippedTextField(null=True)
    distance = StrictDoubleField(null=True)
    comment = StrippedTextField(null=True)


class Price(BaseModel):
    """ Discounts and custom concrete prices. Prices can be specified per Recipe and/or per Customer """

    PRICE_TYPE_ABSOLUTE = 1             # Absolute (new) price of Recipe, e.g. 5000 (CZK)
    PRICE_TYPE_RELATIVE = 2             # Change against listed price of Recipe, e.g. -500 (CZK)
    PRICE_TYPE_PERCENT = 3              # Absolute percentage of Recipe price, e.g. 96 (%).
    PRICE_TYPE_RELATIVE_PERCENT = 4     # Relative change (in percent) of Recipe price, e.g. -5 (%)

    PRICE_TYPES = [
        PRICE_TYPE_ABSOLUTE,
        PRICE_TYPE_RELATIVE,
        PRICE_TYPE_PERCENT,
        PRICE_TYPE_RELATIVE_PERCENT,
    ]

    recipe = ForeignKeyField(Recipe, null=True, backref="prices", on_delete="CASCADE")
    customer = ForeignKeyField(Customer, null=True, backref="prices", on_delete="CASCADE")
    construction_site = ForeignKeyField(ConstructionSite, null=True, backref="prices", on_delete="CASCADE")
    amount = StrictDoubleField()  # abstract amount how price is modified. Meaning depends on 'type' field, see above
    type = EnumField(allowed_values=PRICE_TYPES, default=PRICE_TYPE_ABSOLUTE)

    class Meta:
        indexes = (
            # disallow different discounts for the same recipe, customer and site
            (('recipe', 'customer', 'construction_site'), True),
        )

    def as_endpoint(self):
        """ Enhances data with fields
                customer_name
                recipe_name
                value           properly formatted amount+type in 'rich' syntax, e.g. +20%
                value_str       same as value, but currency is added (if applicable)
        """
        data = self.as_json()
        data["customer_name"] = self.customer.name if self.customer else ""
        data["recipe_name"] = self.recipe.name if self.recipe else ""
        data["construction_site_name"] = self.construction_site.name if self.construction_site else ""

        currency = Setup.singleton().currency_symbol or "(unknown currency)"
        rounded_price = '{0:.{1}f}'.format(self.amount, glo.setup["rounding_precision"])  # TODO REF: use template_filters.round_default?
        if self.type == self.PRICE_TYPE_ABSOLUTE:
            data["value"] = rounded_price
            data["value_str"] = f"{data['value']} {currency}"
        elif self.type == self.PRICE_TYPE_RELATIVE and self.amount >= 0:
            data["value"] = "+" + rounded_price
            data["value_str"] = f"{data['value']} {currency}"
        elif self.type == self.PRICE_TYPE_RELATIVE and self.amount < 0:
            data["value"] = rounded_price
            data["value_str"] = f"{data['value']} {currency}"
        elif self.type == self.PRICE_TYPE_PERCENT:
            data["value"] = f"{self.amount}%"
            data["value_str"] = data["value"]
        elif self.type == self.PRICE_TYPE_RELATIVE_PERCENT and self.amount >= 0:
            data["value"] = f"+{self.amount}%"
            data["value_str"] = data["value"]
        elif self.type == self.PRICE_TYPE_RELATIVE_PERCENT and self.amount < 0:
            data["value"] = f"{self.amount}%"
            data["value_str"] = data["value"]
        else:
            raise NotImplementedError(f"Unknown combination of type '{self.type}' and amount '{self.amount}'")
        return data

    def update_from_json(self, json_data):
        """Translate 'value' field in rich syntax (-50, +20% etc) into 'amount' and 'type' fields"""
        try:
            value = str(json_data.pop("value"))
        except LookupError:
            raise AttributeError("value is required")

        if "%" in value:
            value = value.replace("%", "")
            if ("+" in value) or ("-" in value):
                self.type = self.PRICE_TYPE_RELATIVE_PERCENT
            else:
                self.type = self.PRICE_TYPE_PERCENT
            self.amount = float(value)
        elif ("+" in value) or ("-" in value):
            self.type = self.PRICE_TYPE_RELATIVE
            self.amount = float(value)
        else:
            self.type = self.PRICE_TYPE_ABSOLUTE
            self.amount = float(value)

        return super().update_from_json(json_data)

    def save(self, force_insert=False, only=None):
        """ Implement unique constraints.
            It is disallowed to define more prices for the same customer (when recipe == None).
            But constraint in 'Meta' does not trigger in that situation, so it must be done manually.
        """
        if not self.customer:
            raise IntegrityError("Missing Price.customer")

        if not self.recipe:
            other_records = Price.select().where(Price.customer == self.customer).where(Price.id != self.id).where(Price.recipe.is_null()).count()
            if other_records:
                raise IntegrityError(f"Price for customer '{self.customer.name}' and no recipe already exists.")

        if not self.construction_site:
            other_records = Price.select().\
                where(Price.customer == self.customer).\
                where(Price.recipe == self.recipe). \
                where(Price.construction_site.is_null()).\
                where(Price.id != self.id).\
                count()
            if other_records:
                raise IntegrityError(f"Price for customer '{self.customer.name}', recipe '{self.recipe.name}' and no construction site already exists.")

        return super().save(force_insert, only)

    @property
    def price(self):
        """ Returns price in currency unit (e.g. calculates actual price from all that percents and relative values)"""
        if self.type == self.PRICE_TYPE_ABSOLUTE:
            return self.amount
        elif self.type == self.PRICE_TYPE_RELATIVE:
            return self.recipe.price + self.amount
        elif self.type == self.PRICE_TYPE_PERCENT:
            return self.recipe.price * self.amount / 100
        elif self.type == self.PRICE_TYPE_RELATIVE_PERCENT:
            return self.recipe.price * (100 + self.amount) / 100
        else:
            raise NotImplementedError(f"Unknown combination of type '{self.type}' and amount '{self.amount}'")

    @classmethod
    def get_best_price(cls, recipe, customer, construction_site):
        """ Returns tuple (price, reason_as_string) of appropriate concrete price for given recipe, customer
            and construction_site.
            Defines logic for choosing proper Price record.
            Strategy is to prefer "more accurate" prices instead of "lower"
            (e.g. price for given recipe and customer (if defined) precedes price for recipe only,
            even if the latter is lower)
        """

        if customer and recipe and construction_site:
            prices = cls.select().where(cls.recipe == recipe).where(cls.customer == customer).where(cls.construction_site == construction_site)
            if prices.count():
                return prices[0].price, f"Using special price defined for recipe, customer '{customer.name}' and construction site '{construction_site.name}'"

        if customer:
            prices = cls.select().where(cls.recipe == recipe).where(cls.customer == customer)
            if prices.count():
                return prices[0].price, f"Using special price defined for recipe and customer '{customer.name}'"

            # Price for recipe not found. Try to find general Price for every recipe
            prices = cls.select().where(cls.customer == customer).where(cls.recipe.is_null())
            if prices.count():
                prices[0].recipe = recipe  # must tell the record from what recipe it should count the price
                return prices[0].price, f"Using special price defined for customer '{customer.name}' and every recipe"

        if recipe:
            # no special price for given customer was found, default to price in recipe
            return recipe.price, "Using price directly from recipe"

        raise AttributeError("Customer or recipe must be specified to find out price")


class TransportType(HiddeableModel):
    """ E.g. "sklopka", "mix"  ... just names """
    name = StrippedTextField(unique=True)


class TransportZone(BaseModel):
    """ Transport zones. Some facilities use transport zones instead of vehicle price per km
        (actual mode how transport price is calculated is set up in config.hjson)
    """
    # Zone limits. Distance means "to construction site AND back"
    distance_km_min = StrictIntegerField(default=0)
    distance_min_inclusive = BooleanField(default=False)
    distance_km_max = StrictIntegerField()
    distance_max_inclusive = BooleanField(default=False)

    # TODO REF rename this to "price" (non-trivial, lot of uses). It is not price per m3 anymore. See note below.
    price_per_m3 = StrictDoubleField()  # currency-less

    # If true, transport price is calculated as Order.volume * price_per_m3, otherwise it is just price_per_m3
    price_is_per_m3 = BooleanField(default=True)

    # price is counted from this number, if Order.volume is lower. Not used if price_is_per_m3 == False
    minimal_volume = StrictDoubleField(null=True)

    # In ideal world, null= should be False. But we have existing customer with zones,
    # and do not want to crate "default" TransportType for them.
    transport_type = ForeignKeyField(TransportType, null=True, backref="zones", on_delete="SET NULL")

    @staticmethod
    def get_zones(distance, vehicle_id=None):
        """ Return all TransportZone records, ordered by match.
            - first are (in random order) zones that match both distance and vehicle.transport_type
            - then zones that match only distance
            - then rest of zones
        """
        try:
            transport_type = Car.get_by_id(vehicle_id).transport_type
        except DoesNotExist:
            transport_type = None

        zones_of_distance = \
            TransportZone.select() \
                .where(TransportZone.distance_km_max > distance) \
                .where(TransportZone.distance_km_min < distance) \
                .where(TransportZone.distance_min_inclusive == False) \
                .where(TransportZone.distance_max_inclusive == False) \
            + TransportZone.select() \
                .where(TransportZone.distance_km_max >= distance) \
                .where(TransportZone.distance_km_min < distance) \
                .where(TransportZone.distance_min_inclusive == False) \
                .where(TransportZone.distance_max_inclusive == True) \
            + TransportZone.select() \
                .where(TransportZone.distance_km_max > distance) \
                .where(TransportZone.distance_km_min <= distance) \
                .where(TransportZone.distance_min_inclusive == True) \
                .where(TransportZone.distance_max_inclusive == False) \
            + TransportZone.select() \
                .where(TransportZone.distance_km_max >= distance) \
                .where(TransportZone.distance_km_min <= distance) \
                .where(TransportZone.distance_min_inclusive == True) \
                .where(TransportZone.distance_max_inclusive == True)

        # TODO: does this filter out some results after we did the database query?
        zones_of_distance_and_type = [x for x in zones_of_distance if x.transport_type == transport_type] if transport_type else []

        # Now put found zones in proper order into <ret>. Ugly, but works
        # I do not use shortcut like list(set()), because need to prevent order
        ret = zones_of_distance_and_type.copy()

        for x in zones_of_distance:
            if x not in ret:
                ret.append(x)
        for x in TransportZone.select():
            if x not in ret:
                ret.append(x)

        return ret

    def as_endpoint(self):
        data = super().as_endpoint()
        data["_transport_type_name"] = self.transport_type.name if self.transport_type else ""
        rounded_price = '{0:.{1}f}'.format(self.price_per_m3, glo.setup["rounding_precision"])  # TOOD: use template_filters.round_default?
        data["_price_str"] = rounded_price + " " + (Setup.singleton().currency_symbol or "{unknown currency}")
        return data

    @classmethod
    def get_columns(cls):
        return [
            {"k": "distance_km_min", "title": "{distance_km_min}"},
            {"k": "distance_min_inclusive", "title": "{distance_min_inclusive}"},
            {"k": "distance_km_max", "title": "{distance_km_max}"},
            {"k": "distance_max_inclusive", "title": "{distance_max_inclusive}"},
            {"k": "_transport_type_name", "title": "{transport_type_name}"},
            {"k": "_price_str", "title": "{price}"},
            {"k": "price_is_per_m3", "title": "{price_is_per_m3}"},
            {"k": "minimal_volume", "title": "{minimal_volume}"},
        ]

    @classmethod
    def get_form(cls, data=None):
        transport_type_options = [{"id": None, "title": None}]
        transport_type_options.extend([{"id": x.id, "title": x.as_endpoint().get("name")} for x in TransportType.select()])
        return [
            {
                "k": "distance_km_min",
                "title": "{distance_km_min}",
                "required": 1,
                "number": 1,
            },
            {
                "k": "distance_min_inclusive",
                "label": "{distance_min_inclusive}",
                "_bool": 1,
            },
            {
                "k": "distance_km_max",
                "title": "{distance_km_max}",
                "required": 1,
                "number": 1,
            },
            {
                "k": "distance_max_inclusive",
                "label": "{distance_max_inclusive}",
                "_bool": 1,
            },
            {
                "k": "price_per_m3",
                "title": "{price}",
                "required": 1,
                "number": 1,
            },
            {
                "k": "price_is_per_m3",
                "label": "{price_is_per_m3_desc}",
                "_bool": 1,
            },
            {
                "k": "transport_type",
                "title": "{transport_type}",
                "options": transport_type_options,
            },
        ]


class Driver(HiddeableModel):
    """Database of drivers"""
    name = StrippedTextField(unique=True)
    contact = StrippedTextField(null=True)
    comment = StrippedTextField(null=True)


class _Vehicle(BaseModel):
    """Common ancestor for everything that is more or less a Vehicle - Car and Pump, in our case
       ! Abstract model, see note in README.md
    """
    registration_number = RegistrationNumberField(unique=True)  # SPZ
    driver = ForeignKeyField(Driver, null=True, backref="cars", on_delete="SET NULL")
    comment = StrippedTextField(null=True)
    price_per_km = StrictDoubleField(null=True)  # Prices are Double, because of Euros.

    def as_endpoint(self):
        data = self.as_json()
        data["_driver_name"] = self.driver.name if self.driver else ""
        data["_driver_contact"] = self.driver.contact if self.driver else ""
        return data


class Car(_Vehicle, HiddeableModel):
    """Database of vehicles"""
    operator = StrippedTextField(null=True)  # means 'Company operating this vehicle'
    car_type = StrippedTextField(null=True)
    transport_type = ForeignKeyField(TransportType, null=True, backref="cars", on_delete="SET NULL")

    # When transport_zones are enabled in setup and this flag if set,
    # order with this car will automatically use 'best' transport zone,
    # (instead of letting user to select zone manually)
    charge_transport_automatically = BooleanField(default=False)

    def as_endpoint(self):
        data = super().as_endpoint()
        data["_transport_type_name"] = self.transport_type.name if self.transport_type else ""
        return data

    @classmethod
    def get_form(cls, data=None):
        driver_options = [{"id": None, "title": None}]
        driver_options.extend([{"id": x.id, "title": x.as_endpoint().get("name")} for x in Driver.select()])
        transport_type_options = [{"id": None, "title": None}]
        transport_type_options.extend([{"id": x.id, "title": x.as_endpoint().get("name")} for x in TransportType.select()])
        ret = [
            {
                "k": "registration_number",
                "title": "{registration_number}",
                "required": 1,
            },
            {
                "k": "driver",
                "title": "{driver}",
                "options": driver_options,
                "_smart": 1,
            },
            {
                "k": "price_per_km",
                "title": "{price_per_km}",
                "number": 1,
            },
            {
                "k": "operator",
                "title": "{operator}",
            },
            {
                "k": "car_type",
                "title": "{Car type}",
            },
            {
                "k": "comment",
                "title": "{Note}",
                "full_width": 1,
            },
            {
                "k": "transport_type",
                "title": "{transport_type}",
                "options": transport_type_options,
            },
        ]
        if glo.setup.get("transport_zones"):
            ret.append({
                "k": "charge_transport_automatically",
                "label": "{charge_transport_automatically}",
                "_bool": 1,
            })
        return ret


class Contract(HiddeableModel):
    name = StrippedTextField()
    construction_site = ForeignKeyField(ConstructionSite, backref="contracts", on_delete="RESTRICT")
    customer = ForeignKeyField(Customer, backref="contracts", on_delete="RESTRICT")
    recipe = ForeignKeyField(Recipe, backref="contracts", on_delete="RESTRICT", null=True)
    # TODO NTH REF unify Car/Vehicle duality to vehicle
    vehicle = ForeignKeyField(Car, backref="contracts", on_delete="RESTRICT", null=True)
    default_volume = StrictDoubleField(null=True)
    comment = StrippedTextField(null=True)

    def as_endpoint(self):
        data = self.as_json()
        data["customer_name"] = self.customer.name
        data["construction_site_name"] = self.construction_site.name
        data["recipe_name"] = self.recipe.name if self.recipe else ""
        data["vehicle_registration_number"] = self.vehicle.registration_number if self.vehicle else ""
        return data


class Order(HiddeableModel, AuditedModel):
    STATUS_SENT = 0
    STATUS_PRODUCTION = 1
    STATUS_FINISHED = 2
    STATUS_ABORTED = 3  # by dispatcher
    STATUS_ABORTED_BEFORE_PRODUCTION = 4  # by manager
    STATUS_ABORTED_IN_PRODUCTION = 5  # by alien spaceship

    STATUS_NAMES = {
        STATUS_SENT: "Sent to manager",  # TODO: user has no idea what "manager" means - maybe use the word "queue" or something...
        STATUS_PRODUCTION: "In production",
        STATUS_FINISHED: "Finished",
        STATUS_ABORTED: "Aborted",
        STATUS_ABORTED_BEFORE_PRODUCTION: "Aborted before production",
        STATUS_ABORTED_IN_PRODUCTION: "Aborted in production",
    }

    # Both customer and construction_site are stored primarily as TextFields,
    # filled from Customer and ConstructionSite records.
    # The reason is that linked records can (significantly) change after Order was created.
    # However, references to original records are also stored, in *_record fields.
    # but just as an additional information (which should be therefore handled with some caution)
    # If in doubts, the 'truth' is in TextFields.
    customer = StrippedTextField(null=True)
    customer_record = ForeignKeyField(Customer, null=True, backref="orders", on_delete="SET NULL")
    construction_site = StrippedTextField(null=True)
    construction_site_record = ForeignKeyField(ConstructionSite, null=True, backref="orders", on_delete="SET NULL")
    contract_record = ForeignKeyField(Contract, null=True, backref="orders", on_delete="SET NULL")
    contract_name = StrippedTextField(null=True)

    volume = StrictDoubleField(null=True)
    comment = StrippedTextField(null=True)
    auto_number = StrictIntegerField()   # Auto numbering feature: numbers beginning with state/dispatch.json["order_num_counter"]
    invoice_number = StrictIntegerField(null=True)  # invoice auto number, state/dispatch.json["invoice_num_counter"]
    without_water = BooleanField(default=False)
    payment_type = EnumField(allowed_values=PAYMENT_TYPE_NAMES.keys(), default=PAYMENT_CASH, null=True)  # TODO default ma byt 'nezadano'
    temperature = StrictDoubleField(null=True)  # in Celsius, in time of order creation

    # Modified values for transport price calculation. Workflow: user can set those during expedition.
    # Used in preference to car and construction site distance, when calculating transport price
    distance_driven_modified = StrictDoubleField(null=True)
    price_per_km_modified = StrictDoubleField(null=True)  # ignored when using transport zones

    # Modified prices. Workflow: user can enter arbitrary prices during expedition.
    # They are used in preference to calculated prices
    price_concrete_modified = StrictDoubleField(null=True)
    price_transport_modified = StrictDoubleField(null=True)
    price_surcharges_modified = StrictDoubleField(null=True)

    # User can select arbitrary TransportZone in Expedition. Used in preference to zone determined by distance.
    transport_zone_modified = ForeignKeyField(TransportZone, null=True, backref="orders", on_delete="RESTRICT")

    # Explicitly states that user selected order without transport.
    # This can't be done by setting transport_zone_modified=null, due to ambiguities in 1) historical orders and 2) program running without zones.
    # Also not the same as setting price_transport_modified=0, cause "order without transport" and "order with zero transport price"
    # can be distinguished in printouts and accounting in general
    without_transport = BooleanField(default=False)

    # TODO NTH NEXTLIFE na dodaci list pouzit :virtualni: property best_known_temperature, ktera je prednostne z Batch, a sekundarne z Order.

    status = EnumField(allowed_values=STATUS_NAMES.keys(), default=STATUS_SENT)
    t = TimestampField(default=TimestampField.now)

    recipe_record = ForeignKeyField(Recipe, null=True, backref="orders", on_delete="SET NULL")

    # Values of that fields are copied from other tables when creating an order.
    # The reason is to preserve values in moment of order
    # (later modifications of the original table would otherwise modify values in order).
    # All such values are prefixed with "<something>_" just to distinguish it from the rest of the model

    # Fields copied from Recipe, prefix r_
    r_name = StrippedTextField()
    r_recipe_class = StrippedTextField(null=True)
    r_description = StrippedTextField(null=True)
    r_comment = StrippedTextField(null=True)
    r_consistency_class = StrippedTextField(null=True)
    r_exposure_classes = StrippedTextField(null=True)
    r_batch_volume_limit = StrictDoubleField(null=True)
    r_lift_pour_duration = StrictDoubleField(null=True)
    r_lift_semi_pour_duration = StrictDoubleField(null=True)
    r_mixer_semi_opening_duration = StrictDoubleField(null=True)
    r_mixer_semi_opening2_duration = StrictDoubleField(null=True)
    r_mixer_opening_duration = StrictDoubleField(null=True)
    r_mixing_duration = StrictDoubleField(null=True)
    r_k_value = StrictDoubleField(null=True)
    r_k_ratio = StrictDoubleField(null=True)
    r_number = StrippedTextField(null=True)  # see note in Recipe for exact purpose of Recipe.number field
    r_d_max = StrictIntegerField(null=True)
    r_cl_content = StrictDoubleField(null=True)
    r_vc = StrictDoubleField(null=True)
    r_cement_min = StrictDoubleField(null=True)
    r_workability_time = StrictIntegerField(null=True)

    # Price in order is based not only on Recipe price, but also on what is defined in Price table
    # This fields contain resulting price and also a note, how it was calculated
    r_price = StrictDoubleField(null=True)
    r_price_note = StrippedTextField(null=True)

    def archive(self):
        """Moves order to 'archived' state and saves modified record into DB
        (Instead of deleting, just set up 'Archive' flag to hide it from view)
        TODO NTH REF QUE: this constraint was removed from UX, because hiding Orders is reversible action now. Discuss archive behaviour (and remove this code)
        """
        if self.status in [self.STATUS_PRODUCTION, self.STATUS_SENT]:
            raise RuntimeError(f"Order {self.id} can't be archived: is in production")
        self.hidden = True
        self.save()

    def set_recipe(self, recipe_id):
        """ Fills all recipe related (r_) fields with values from recipe identified by <recipe_id>
            Does NOT copy recipe materials (this must be done manually), does NOT copy price (depends on customer)
            Throws ValueError if no such recipe exists
        """
        try:
            r = Recipe.get_by_id(recipe_id)
        except DoesNotExist:
            raise ValueError("{Recipe must be specified}")

        self.recipe_record = r
        self.r_name = r.name
        self.r_recipe_class = r.recipe_class
        self.r_description = r.description
        self.r_comment = r.comment
        self.r_consistency_class = r.consistency_class
        self.r_exposure_classes = r.exposure_classes
        self.r_batch_volume_limit = r.batch_volume_limit
        self.r_lift_pour_duration = r.lift_pour_duration
        self.r_lift_semi_pour_duration = r.lift_semi_pour_duration
        self.r_mixer_semi_opening_duration = r.mixer_semi_opening_duration
        self.r_mixer_semi_opening2_duration = r.mixer_semi_opening2_duration
        self.r_mixer_opening_duration = r.mixer_opening_duration
        self.r_mixing_duration = r.mixing_duration
        self.r_k_value = r.k_value
        self.r_k_ratio = r.k_ratio
        self.r_number = r.number
        self.r_d_max = r.d_max
        self.r_cl_content = r.cl_content
        self.r_vc = r.vc
        self.r_cement_min = r.cement_min
        self.r_workability_time = r.workability_time

    def set_price(self, recipe):
        """ Set price based on given recipe and discounts defined in Price table"""
        self.r_price, self.r_price_note = Price.get_best_price(recipe, self.customer_record, self.construction_site_record)
        logging.debug(f"Set order price {self.r_price} for reason '{self.r_price_note}'")

    def set_transport_zone(self, transport_zone):
        """ transport_zone are POST data received via endpoint (copy of TransportZone record).
            We're interested only in 'id' part ot this
        """
        if glo.setup.get("transport_zones", False):
            if transport_zone:
                self.transport_zone_modified = TransportZone.get_by_id(transport_zone["id"])
                self.without_transport = False
            else:
                self.without_transport = True

    def calc_price_concrete(self):
        """ Returns total price for ordered product (without shipping costs and surcharges), as calculated from record.
            Prices are VAT-less and currency-less
            If price cannot be calculated (missing some information), returns None
        """
        if self.r_price is None:
            return None
        return self.r_price * self.volume

    def calc_distance_driven(self):
        """ As name says. Preferred is distance_driven_modified, otherwise taken from delivery """
        if self.distance_driven_modified is not None:
            return self.distance_driven_modified
        if not self.deliveries:
            return None
        return self.deliveries[0].distance_driven

    def calc_price_transport(self):
        """ Returns transport price (VAT-less, currency-less), depending on setup (transport_zones or price per km?).
            If price cannot be calculated (missing some information), returns None
            TODO REF NTH: maybe it would be nicer to return 0 (if price cannot be calculated)
                None value is most probably unused, and returning two "false" values complicates test in invoice.html
        """
        if self.without_transport:
            return 0

        if (kms := self.calc_distance_driven()) is None:
            return None

        if glo.setup.get("transport_zones", False):
            # As a fallback it uses 1st zone found, which is random in case there is more zones for given distance.
            # But this seems to be OK - user can change required zone explicitly in expedition form
            try:
                zone = self.transport_zone_modified or TransportZone.get_zones(kms)[0]
            except LookupError:
                return None
            try:
                if zone.price_is_per_m3:
                    return zone.price_per_m3 * max(self.volume, zone.minimal_volume or 0)
                else:
                    return zone.price_per_m3
            except TypeError:
                return None
        else:
            if self.price_per_km_modified:
                price = self.price_per_km_modified
            else:
                try:
                    price = self.deliveries[0].car_price_per_km
                except (TypeError, IndexError):
                    return None

            try:
                return price * kms
            except TypeError:
                pass

    def calc_price(self):
        return sum([self.price_concrete or 0, self.price_transport or 0, self.price_surcharges or 0])

    def calc_price_surcharges(self):
        """ total price of surcharges (VAT-less, currency-less)"""
        if not self.surcharges:
            return 0
        return sum([x.price_total for x in self.surcharges])

    @property
    def price_concrete(self):
        """ Concrete price for accounting purposes. Due to workflow, modified (aka user-set) price is preferred. """
        # note: test against None value (meaning 'not set'). Do not use simple "or",
        # because self.price_*_modified==0 meant that user want the price to be zero. Ditto for next two properties.
        if (x := self.price_concrete_modified) is not None:
            return x
        return self.calc_price_concrete()

    @property
    def price_transport(self):
        """ Transport price for accounting purposes. Due to workflow, modified (aka user-set) price is preferred. """
        if (x := self.price_transport_modified) is not None:
            return x
        return self.calc_price_transport()

    @property
    def price_surcharges(self):
        """ Surcharges price for accounting purposes. Due to workflow, modified (aka user-set) price is preferred. """
        if (x := self.price_surcharges_modified) is not None:
            return x
        return self.calc_price_surcharges()

    @property
    def price_concrete_correction(self):
        """ Difference between calculated and modified concrete price. Negative: discounted, positive: surcharged"""
        if (x := self.price_concrete_modified) is None:
            return 0
        return x - self.calc_price_concrete()

    @property
    def price_surcharges_correction(self):
        """ Difference between calculated and modified surcharges price. Negative: discounted, positive: surcharged"""
        if (x := self.price_surcharges_modified) is None:
            return 0
        return x - self.calc_price_surcharges()

    def calc_rounding(self):
        """ Returns amount of currency unit that has to be added to price_total with VAT applied, so
            the result is rounded to int.
        """
        total_with_vat = with_vat(self.price_total)
        try:
            # we can't use the standard round() because its behaviour is "half to even" - we need "half away from zero"
            #return round(total_with_vat, 0) - total_with_vat
            return float(Decimal(total_with_vat).quantize(Decimal(0), rounding=ROUND_HALF_UP)) - total_with_vat
        except TypeError:
            return 0

    @property
    def price_grand_total(self):
        """ Returns price with vat, rounded - that means amount "to be paid" """
        try:
            return with_vat(self.price_total) + self.calc_rounding()
        except TypeError:
            return self.price_total

    @property
    def price_total(self):
        """ total price of order, including concrete, transport and surcharges. If something is missing, returns None """
        return sum([self.price_concrete or 0, self.price_transport or 0, self.price_surcharges or 0])

    def as_endpoint(self):
        data = super().as_endpoint()
        data["surcharges"] = [x.as_endpoint() for x in self.surcharges]
        data["status_name"] = self.get_status_name()

        # This three values are used in 'edit order' feature. But they can slow down long lists (some of
        # _calc functions are pretty complex), so it is a candidate for optimization
        data["price_concrete_calculated"] = self.calc_price_concrete()
        data["price_surcharges_calculated"] = self.calc_price_surcharges()
        data["price_transport_calculated"] = self.calc_price_transport()

        data["payment_type_str"] = "{%s}" % PAYMENT_TYPE_NAMES.get(self.payment_type, "not_set")

        try:
            delivery = self.deliveries[0]  # TODO: what about multiple deliveries?
            data["vehicle_id"] = delivery.car_registration_number
            data["vehicle_record"] = delivery.car_record.id if delivery.car_record else None
        except IndexError:
            pass
        return data

    def get_status_name(self):
        return self.STATUS_NAMES[self.status]

    def get_payment_type_name(self):
        return PAYMENT_TYPE_NAMES.get(self.payment_type, "")

    def comm_filename(self, suffix):
        """Returns plain filename (without path), that can be used for communication with other Asterix modules
        Asterix rules for communication are loose, the name can be pretty much anything, but the convention is
        to use timestamp + user number
        """
        time_str = arrow.get().to(settings.TIMEZONE).format("YYYYMMDDHHmmss")
        return f"{time_str}_{self.auto_number}.{suffix}"

    @property
    def t_human(self):
        return func.human_datetime(self.t)

    def save(self, force_insert=False, only=None):
        if float(self.volume) <= 0:
            raise ValueError("Order.volume must be a positive number")
        return super().save(force_insert, only)

    def change_status(self, new_status):
        # TODO QUE review this constraints

        if self.status == new_status:
            return

        allowed_changes = {
            self.STATUS_SENT: [self.STATUS_PRODUCTION, self.STATUS_FINISHED, self.STATUS_ABORTED, self.STATUS_ABORTED_IN_PRODUCTION, self.STATUS_ABORTED_BEFORE_PRODUCTION],
            self.STATUS_PRODUCTION: [self.STATUS_FINISHED, self.STATUS_ABORTED_IN_PRODUCTION],
            self.STATUS_FINISHED: [],
            self.STATUS_ABORTED_BEFORE_PRODUCTION: [],
            self.STATUS_ABORTED_IN_PRODUCTION: [],
            self.STATUS_ABORTED: [self.STATUS_ABORTED_BEFORE_PRODUCTION, self.STATUS_FINISHED],
        }

        if new_status in allowed_changes[self.status]:
            logging.info(f"Status of Order.{self.id} changed from '{self.STATUS_NAMES[self.status]}' to '{self.STATUS_NAMES[new_status]}'")
            self.status = new_status
            self.save()
        else:
            raise ValueError(f"Order status change from '{self.STATUS_NAMES[self.status]}' to '{self.STATUS_NAMES[new_status]}' is not allowed")

    @db.atomic()
    def update_surcharges(self, data):
        """ Updates order surcharges based on data in form:
            [ {"name": <str>, "price", <str or float>, "amount", <str or float>, "price_type": <str or int>, "unit_name": <str>}, ...]
        """
        OrderSurcharge.delete().where(OrderSurcharge.order == self).execute()
        nonempty_surcharges = [x for x in data if x.get("name")]
        for surcharge in nonempty_surcharges:
            OrderSurcharge.create(
                order=self,
                name=surcharge["name"],
                price=float(surcharge["price"]),
                price_type=int(surcharge["price_type"]),
                unit_name=surcharge["unit_name"],
                amount=int(surcharge.get("amount", 1))
            )


class Delivery(BaseModel):
    """Means: one car, leaving production facility with load of concrete.
    One Order can have 1 or more deliveries
    """
    # TODO: theoretically, yes. but the code itself has .deliveries[0] hard-coded everywhere

    t = TimestampField(default=TimestampField.now)

    # Those are part of delivery sheet. In typical workflow user should set just the time part.
    # However, we stick to timestamps - first, to be ready for "over the midnight" scenario,
    # second, it is just more pleasant to work with timestamps
    construction_site_arrival_t = TimestampField(null=True)
    unload_start_t = TimestampField(null=True)
    unload_end_t = TimestampField(null=True)

    car_record = ForeignKeyField(Car, null=True, backref="deliveries", on_delete="SET NULL")

    # Fields copied from Car (and Driver), prefix car_
    car_registration_number = StrippedTextField(null=True)
    car_driver = StrippedTextField(null=True)
    car_driver_contact = StrippedTextField(null=True)
    car_operator = StrippedTextField(null=True)
    car_car_type = StrippedTextField(null=True)
    car_price_per_km = StrictDoubleField(null=True)

    # Field copied from construction site
    site_distance = StrictDoubleField(null=True)

    # According to the setup, we can calc distance driven 1* or 2*
    # This calculated value must be stored in model (otherwise is changed when setup changes)
    distance_driven = StrictDoubleField(null=True)

    order = ForeignKeyField(Order, backref="deliveries", on_delete="CASCADE")

    @property
    def construction_site_arrival_human(self):
        return func.human_datetime(self.construction_site_arrival_t)

    @property
    def unload_start_human(self):
        return func.human_datetime(self.unload_start_t)

    @property
    def unload_end_human(self):
        return func.human_datetime(self.unload_end_t)

    def set_construction_site(self, site):
        """ Sets site-related values from instance of ConstructionSite
            TODO REF NTH it would be neat to rename self.distance_driven to self._distance_driven
                and self.site_distance to self._site_distance
                and access both properties via property getter
        """
        if site:
            self.site_distance = site.distance
            self.distance_driven = self.site_distance * Setup.singleton().distance_factor if self.site_distance else None


class OrderMaterial(BaseModel):
    """Holds copy of Material and RecipeMaterial values for particular order.
    See comments in Order model to read more.
    """

    type = StrippedTextField()
    name = StrippedTextField()
    long_name = StrippedTextField(null=True)
    unit = StrippedTextField(null=True)
    comment = StrippedTextField(null=True)

    # Keep the connection to original material: module "statistics" uses it
    material = ForeignKeyField(Material, backref="orders", null=True, on_delete="SET NULL")

    # values of this field are copied from RecipeMaterial.sequence_id, where it serves as primary key.
    # so the values can be pretty high and contain some "spaces", e.g. 712, 713, 720...
    # However, the purpose is just to hold order of materials - good enough for that.
    sequence_number = StrictIntegerField()

    order = ForeignKeyField(Order, backref="materials", on_delete="CASCADE")
    amount = StrictDoubleField()
    delay = StrictDoubleField(null=True)

    # Both are just for material of type "Addition", see constraint below
    k_value = StrictDoubleField(null=True)
    k_ratio = StrictDoubleField(null=True)

    def save(self, force_insert=False, only=None):
        """ Constraint: Do not allow k_value and k_ratio for other materials than Addition."""
        # Naive implementation. Better way is field validation
        if (self.k_value or self.k_ratio) and self.material.type != "Addition":
            raise ValueError("Cannot set k_value or k_ratio for OrderMaterial, which is not of type 'Addition'")
        return super().save(force_insert, only)


class Pump(_Vehicle, HiddeableModel):
    """Database of concrete pumps"""
    pump_type = StrippedTextField(null=True)  # I mimic Car model behaviour - plain text
    price_per_hour = StrictDoubleField(null=True)


class _Surcharge(BaseModel):
    """ Common ancestor for all types of surcharges """
    name = StrippedTextField(unique=True)
    price = StrictDoubleField(null=True)  # without currency. Assumption is that price is (like other prices) currency-less.


class PumpSurcharge(_Surcharge):
    """ Pump surcharges are common for entire company """

    # Technically, all this PRICE_TYPE_NAMES thing and according checks in save() method
    # are 90% copypaste with similar code in CompanySurcharge.
    # But I want to be explicit here, not sure how Surcharges gonna evolve in the future,
    # so separation of this two models may be? a good idea

    PRICE_TYPE_NAMES = {  # Values are strings used as keys for translation
        SURCHARGE_PRICE_FIXED: "price_fixed",
        SURCHARGE_PRICE_PER_OTHER_UNIT: "price_per_other_unit",
    }

    export_name = StrippedTextField(null=True)  # for export into the accounting software
    price_type = EnumField(allowed_values=PRICE_TYPE_NAMES.keys(), default=SURCHARGE_PRICE_FIXED)
    unit_name = StrippedTextField(null=True)    # e.g. meter, 1/4 hour etc. Valid only when price_type==SURCHARGE_PRICE_PER_OTHER_UNIT

    def save(self, force_insert=False, only=None):
        if self.unit_name and int(self.price_type) != SURCHARGE_PRICE_PER_OTHER_UNIT:
            raise ValueError(f"PumpSurcharge with price type '{self.PRICE_TYPE_NAMES[int(self.price_type)]}' cannot set field 'unit_name'")
        return super().save(force_insert, only)

    @classmethod
    def get_form(cls, data=None):
        if data is None:
            data = {}
        #price_type_options = [{"id": None, "title": None}]
        price_type_options = []
        price_type_options.extend([{"id": k, "title": "{%s}" % v} for (k, v) in cls.PRICE_TYPE_NAMES.items()])
        return [
            {
                "k": "name",
                "title": "{name}",
                "required": 1,
            },
            {
                "k": "export_name",
                "title": "{export_name}",
            },
            {
                "k": "price",
                "title": "{price}",
                "number": 1,
            },
            {
                "k": "price_type",
                "title": "{price_type}",
                "options": price_type_options,
            },
            {
                "k": "unit_name",
                "title": "{unit_name}",
                "disabled": bool(data.get("price_type") != 2),  # TODO: hard-coded shit
            },
        ]


class PumpOrder(HiddeableModel):
    """Orders for concrete pump"""

    auto_number = StrictIntegerField(default=0)   # Auto numbering feature: similar as in Order
    t = TimestampField(default=TimestampField.now)
    kms = StrictDoubleField(null=True)
    hours = StrictDoubleField(null=True)

    # Fields copied from Pump (and Driver), prefix pump_ + link to original record (if any)
    pump_registration_number = StrippedTextField(null=True)
    pump_driver = StrippedTextField(null=True)
    pump_driver_contact = StrippedTextField(null=True)
    pump_pump_type = StrippedTextField(null=True)
    pump_price_per_km = StrictDoubleField(null=True)
    pump_price_per_hour = StrictDoubleField(null=True)
    pump_record = ForeignKeyField(Pump, null=True, backref="pump_orders", on_delete="SET NULL")

    # Fields copied from ConstructionSite, prefix construction_site_ + link to original record (if any)
    construction_site_name = StrippedTextField(null=True)
    construction_site_address = StrippedTextField(null=True)
    construction_site_city = StrippedTextField(null=True)
    construction_site_zip = StrippedTextField(null=True)
    construction_site_record = ForeignKeyField(ConstructionSite, null=True, backref="pump_orders", on_delete="SET NULL")

    # Fields copied from Customer, prefix customer_ + link to original record (if any)
    customer_name = StrippedTextField(null=True)
    customer_address = StrippedTextField(null=True)
    customer_city = StrippedTextField(null=True)
    customer_zip = StrippedTextField(null=True)
    customer_company_idnum = StrippedTextField(null=True)
    customer_vat_idnum = StrippedTextField(null=True)
    customer_record = ForeignKeyField(Customer, null=True, backref="pump_orders", on_delete="SET NULL")

    def as_endpoint(self):
        data = self.as_json()
        data["surcharges"] = [x.as_endpoint() for x in self.surcharges]
        return data

    @property
    def t_human(self):
        return func.human_datetime(self.t)

    def set_customer(self, customer_id):
        customer = Customer.get_or_none(id=customer_id)
        self.customer_record = customer
        self.customer_name = customer.name if customer else None
        self.customer_address = customer.address if customer else None
        self.customer_city = customer.city if customer else None
        self.customer_zip = customer.zip if customer else None
        self.customer_company_idnum = customer.company_idnum if customer else None
        self.customer_vat_idnum = customer.vat_idnum if customer else None

    def set_construction_site(self, site_id):
        cs = ConstructionSite.get_or_none(id=site_id)
        self.construction_site_record = cs
        self.construction_site_name = cs.name if cs else None
        self.construction_site_address = cs.address if cs else None
        self.construction_site_city = cs.city if cs else None
        self.construction_site_zip = cs.zip if cs else None

    def set_pump(self, pump_id):
        pump = Pump.get_or_none(id=pump_id)
        self.pump_record = pump
        # pump must be specified, so it is ok just copy its values without existence test
        self.pump_registration_number = pump.registration_number
        self.pump_pump_type = pump.pump_type
        self.pump_price_per_km = pump.price_per_km
        self.pump_price_per_hour = pump.price_per_hour
        if pump.driver:
            self.pump_driver = pump.driver.name
            self.pump_driver_contact = pump.driver.contact
        else:
            self.pump_driver = None
            self.pump_driver_contact = None

    def update_from_json(self, data):
        self.update_surcharges(data.pop("surcharges", []))

        # update record itself
        self.set_customer(data.pop("customer", None))
        self.set_construction_site(data.pop("construction_site", None))
        self.set_pump(data.pop("pump", None))
        super().update_from_json(data)
        self.save()
        return self

    @db.atomic()
    def update_surcharges(self, data):
        """ Updates order surcharges based on data in form:
            [ {"name": <str>, "price", <str or float>, "amount", <str or float>, "price_type": <str or int>, "unit_name": <str>}, ...]
        """
        PumpOrderSurcharge.delete().where(PumpOrderSurcharge.order == self).execute()
        nonempty_surcharges = [x for x in data if x.get("name")]
        for surcharge in nonempty_surcharges:
            PumpOrderSurcharge.create(
                order=self,
                price_unit=surcharge["price"],
                name=surcharge["name"],
                export_name=surcharge["export_name"],
                amount=int(surcharge.get("amount", 1)),
                price_type=int(surcharge["price_type"]),
                unit_name=surcharge["unit_name"]
            )


class PumpOrderSurcharge(BaseModel):
    """ Surcharge for pump order. The workflow is complex:
        - record is created when order is created.
            Values like name, price... for every PumpSurcharge are copied into appropriate fields
        - amount can be altered any time later (normally after Pump returns from construction site
          and company knows, which surcharges were taken.
    """
    order = ForeignKeyField(PumpOrder, backref="surcharges", on_delete="CASCADE")

    # This values are copied from PumpSurcharge:
    name = StrippedTextField()
    price_unit = StrictDoubleField(null=True)
    export_name = StrippedTextField(null=True)

    # for on/off type of surcharges use 0 or 1 - which seems strange but is strictly logical.
    amount = StrictIntegerField(null=True)

    price_type = EnumField(allowed_values=PumpSurcharge.PRICE_TYPE_NAMES.keys(), default=SURCHARGE_PRICE_FIXED)
    unit_name = StrippedTextField(null=True)    # e.g. meter, 1/4 hour etc. Valid only when price_type==SURCHARGE_PRICE_PER_OTHER_UNIT

    @property
    def price_total(self):
        try:
            return self.price_unit * self.amount
        except TypeError:
            pass

    class Meta:
        indexes = (
            (('name', 'order'), True),
        )


class CompanySurcharge(_Surcharge):
    """ Surcharges charged for concrete orders. Defined for entire company """

    PRICE_TYPE_NAMES = {  # Values are strings used as keys for translation
        SURCHARGE_PRICE_FIXED: "price_fixed",
        SURCHARGE_PRICE_PER_CUBIC_METER: "price_per_m3",
        SURCHARGE_PRICE_PER_OTHER_UNIT: "price_per_other_unit",
    }

    price_type = EnumField(allowed_values=PRICE_TYPE_NAMES.keys(), default=SURCHARGE_PRICE_FIXED)
    unit_name = StrippedTextField(null=True)    # e.g. meter, 1/4 hour etc. Valid only when price_type==SURCHARGE_PRICE_PER_OTHER_UNIT

    def save(self, force_insert=False, only=None):
        if self.unit_name and int(self.price_type) != SURCHARGE_PRICE_PER_OTHER_UNIT:
            raise ValueError(f"CompanySurcharge with price type '{self.PRICE_TYPE_NAMES[int(self.price_type)]}' cannot set field 'unit_name'")
        return super().save(force_insert, only)


class OrderSurcharge(BaseModel):
    """ Surcharge for concrete order. The workflow is similar as for PumpSurcharge,
        except that initial values are taken from CompanySurcharge table
    """
    order = ForeignKeyField(Order, backref="surcharges", on_delete="CASCADE")

    # Values copied from CompanySurcharge:
    name = StrippedTextField()
    price = StrictDoubleField(null=True)
    price_type = EnumField(allowed_values=CompanySurcharge.PRICE_TYPE_NAMES.keys())
    unit_name = StrippedTextField(null=True)

    # for on/off type of surcharges use 0 or 1 - which seems strange but is strictly logical.
    amount = StrictIntegerField(null=True)

    class Meta:
        indexes = (
            (('name', 'order'), True),
        )

    @property
    def price_total(self):
        if self.price_type == SURCHARGE_PRICE_FIXED:
            return self.price
        elif self.price_type == SURCHARGE_PRICE_PER_OTHER_UNIT:
            try:
                return self.price * self.amount
            except TypeError:
                pass
        elif self.price_type == SURCHARGE_PRICE_PER_CUBIC_METER:
            try:
                return self.price * self.order.volume
            except TypeError:
                pass
        else:
            raise NotImplementedError(f"OrderSurcharge: can't figure out total_price due to unknown price type '{self.price_type}'")


class Setup(BaseModel):
    """Setup values editable by user"""

    company_name = StrippedTextField()
    company_address = StrippedTextField(null=True)
    company_zip = StrippedTextField(null=True)
    company_city = StrippedTextField(null=True)
    company_idnum = StrippedTextField(null=True)  # ICO
    company_vat_idnum = StrippedTextField(null=True)  # DIC
    company_legal = StrippedTextField(null=True)  # For text of "Zapsana v OR..."
    customer_consent = StrippedTextField(null=True)  # Text like "Customer consents, that..." for printouts
    customer_consent_pump = StrippedTextField(null=True)  # ditto for pump orders

    # Facility is Provozovna
    facility_name = StrippedTextField(null=True)
    facility_address = StrippedTextField(null=True)
    facility_city = StrippedTextField(null=True)
    facility_zip = StrippedTextField(null=True)
    facility_code = StrippedTextField(null=True)

    certification_text = StrippedTextField(null=True)  # to be printed on sheets

    # Currency and vat rate has no financial meaning. See notes in README.md
    currency_symbol = StrippedTextField(null=True)
    vat_rate = StrictIntegerField(null=True)   # e.g. 21

    # Formatting string for datetime fields, used in templates. Syntax as in arrow.format() function
    # https://arrow.readthedocs.io/en/latest/guide.html#format
    # Default formatting is defined in web.customized_timestamp_filter
    datetime_format = StrippedTextField(null=True)

    # If True, actual distance to construction_site is doubled (meaning ride to site and back),
    # in all distance-based calculations (especially when determining proper TransportZone)
    count_distance_doubled = BooleanField(default=True)

    # If True, generated printouts are automatically send to printer
    auto_print = BooleanField(default=True)

    @property
    def distance_factor(self):
        """ Just for convenience. Returns factor, by which the distance should be multiplied
            when calculating transport
        """
        return 2 if self.count_distance_doubled else 1

    @staticmethod
    def singleton():
        """Setup is the model with single row. So there is a method to access this row
        or to create a new one if no rows exists
        """
        try:
            return __class__.select()[0]
        except IndexError:
            return __class__()


class User(BaseModel):
    """Users allowed to login.
    Security info: password_hash_sha256 field is one-way hashed with SHA-256 algorithm,
    so there is actually no password stored in DB
    and thus can be cracked *only* by standard brute-forcing.
    This should be fairly enough for this level of protection.
    """

    username = StrippedTextField(unique=True)
    password_hash_sha256 = StrippedTextField()
    can_edit_users = BooleanField(default=False, null=True)

    @staticmethod
    def hash(password):
        """Only password hashes are stored. Use this func to create hash from plaintext password"""
        return sha256(password.encode("utf-8")).hexdigest()

    def as_endpoint(self):
        """ do not propagate 'password_hash' field to frontend"""
        return {"id": self.id, "username": self.username, "can_edit_users": self.can_edit_users}


class LockedTable(BaseModel):
    """ Defines models, locked for particular user
        Every record in this model means: "user <user> cannot write into model <table_name>"

        How locking works:
        Firstly, it IS NOT done in one place in model (e.g. by creating LockableModelMixin or so)
        It would lead to leaky abstraction (because model should not know which user is logged in).
        As a locking implementation, there is a decorator @guard_table_lock + some helper funcs, all defined
        in decorators.py, used by endpoints in web.py

        On a UX side, there is a model 'userLocks', initiated after login, from which are derived some UX tricks,
        like showing 'lock' icons in menu.
    """

    # Note: if you add something here, modify also 'TABLE_NAME_MAPPING' and 'const Layout' (lock icons) in script.js
    # Read also docstring above, about locking implementation
    LOCKABLE_TABLES = ["Material", "Recipe", "TransportType", "Driver", "Car", "Pump", "ConstructionSite", "Customer", "Contract"]  # TODO: why strings?
    user = ForeignKeyField(User, backref="locked_tables", on_delete="CASCADE")
    table_name = TextField(null=False)

    class Meta:
        indexes = (
            (('user', 'table_name'), True),
        )

    def save(self, force_insert=False, only=None):
        """ Allow only proper table names"""
        if self.table_name not in self.LOCKABLE_TABLES:
            raise ValueError(f"Table '{self.table_name}' is not lockable, use one of [{', '.join(self.LOCKABLE_TABLES)}]")
        return super().save(force_insert, only)


class Batch(BaseModel):
    """One produced batch, as received from manager via .be1/.be2 file
    _rq fields are from section Batch_Request
    _e1 from Batch_Evidence1
    _e2 from Batch_Evidence2
    rest explained in comment
    """

    order = ForeignKeyField(Order, backref="batches", on_delete="CASCADE")
    filename = StrippedTextField(null=True)  # be* file used to create this record
    volume = StrictDoubleField(null=True)  # volume produced in this batch, from section Batch_Request
    batch_number = StrictIntegerField(null=True)  # ord number of batch in sequence, 1-based
    batch_count = StrictIntegerField(null=True)  # how many batches was (should be) produced
    production_start_t = TimestampField(null=True)  # from section Batch_Request
    production_end_t = TimestampField(null=True)  # from section Batch_Evidence2
    mixing_duration = StrictDoubleField(null=True)  # in sec, from section Batch_Evidence2
    consistency = StrictDoubleField(null=True)  # units unknown, from section Batch_Evidence2
    additional_water = StrictDoubleField(null=True)  # in kgs, from section Batch_Evidence2
    water_correction_rq = StrictDoubleField(null=True)
    water_correction_e1 = StrictDoubleField(null=True)
    water_temperature_calculated = StrictDoubleField(null=True)  # from section Batch_Request
    continuous_mode = StrictIntegerField(null=True)  # from section Batch_Request
    water_temperature = StrictDoubleField(null=True)  # from section Batch_Request
    moisture_rq = StrictDoubleField(null=True)
    moisture_e2 = StrictDoubleField(null=True)
    production_mode_e1 = StrippedTextField(null=True)  # A.. automaticky, R (asi?) ..rucne
    production_mode_e2 = StrippedTextField(null=True)
    cement_temperature = StrictDoubleField(null=True)  # from section Batch_Evidence2

    # TODO NTH WAIT RP pridat pole na teplotu prostredi co prijde z vyroby. Zatim neni v .be souborech - pridat az bude

    @property
    def production_end_human(self):
        return func.human_datetime(self.production_end_t)

    @property
    def production_start_human(self):
        return func.human_datetime(self.production_start_t)


class BatchMaterial(BaseModel):
    """Holds amounts of material used in production
    Source of data for that model are .be* files
    _rq fields are from section Batch_Request, _e1 from Batch_Evidence1
    """

    batch = ForeignKeyField(Batch, backref="materials", on_delete="CASCADE")
    material = ForeignKeyField(OrderMaterial, backref="consumptions", on_delete="CASCADE")

    amount_recipe = StrictDoubleField(null=True)  # how many units was set in recipe (and required by Dispatch)
    amount_rq = StrictDoubleField(null=True)  # how much was required by Manager
    amount_e1 = StrictDoubleField(null=True)  # how much was really consumed

    # Those fields are stored just for evidence. We do not use them right now.
    silo_major_rq = StrictIntegerField(null=True)
    silo_minor_rq = StrictIntegerField(null=True)
    humidity_rq = StrictDoubleField(null=True)
    internal_humidity_rq = StrictDoubleField(null=True)
    density_rq = StrictDoubleField(null=True)
    temperature_rq = StrictDoubleField(null=True)
    bin_rq = StrictIntegerField(null=True)
    delay_rq = StrictDoubleField(null=True)
    silo_major_e1 = StrictIntegerField(null=True)
    silo_minor_e1 = StrictIntegerField(null=True)
    humidity_e1 = StrictDoubleField(null=True)


# Hold table list for creation and deletion of tables (where proper order is necessary)
TABLES = [
    Setup,
    Contract,
    TransportType,
    Car,
    PumpSurcharge,
    Pump,
    PumpOrderSurcharge,
    PumpOrder,
    Driver,
    ConstructionSite,
    Price,
    Customer,
    Delivery,
    Sample,
    BatchMaterial,
    Batch,
    OrderSurcharge,
    Order,
    OrderMaterial,
    RecipeMaterial,
    StockMovement,
    Material,
    RecipeProduction,
    Recipe,
    Defaults,
    LockedTable,
    User,
    TransportZone,
    CompanySurcharge
]


# TODO: move this to web?
def queryset_to_ux(queryset):
    """Converts peewee queryset to structure used in UX"""
    return {"data": [x.as_endpoint() for x in queryset.objects()]}
