""" Custom database fields for models
    Basically, extensions of peewee models
"""

import time
from peewee import DoubleField, IntegerField, TextField


class RegistrationNumberField(TextField):
    """Special handling of RegistrationNumber field for cars. Uppercase and stripped.
       TODO REF NTH: This is in general bad style, we should use something like mixins.
         However, this need deep though and propably more than a little of refactoring
    """

    def db_value(self, value):
        return None if value is None else value.strip().upper()


class StrictDoubleField(DoubleField):
    field_type = "REAL"

    def db_value(self, value):
        # Do not convert null values, if they are explicitly allowed in field instantiation
        if self.null and value is None:
            return value

        try:
            return float(value)
        except TypeError as e:
            raise ValueError(f"{self.model.__name__}.{self.name}:{value}:{e}")


class StrictIntegerField(IntegerField):
    field_type = "INTEGER"

    def db_value(self, value):
        # Do not convert null values, if they are explicitly allowed in field instantiation
        if self.null and value is None:
            return value

        try:
            return int(value)
        except ValueError as e:
            raise ValueError(f"{self.model.__name__}.{self.name}: {e}")


class TimestampField(StrictIntegerField):
    """Own type to represent timedate - Asterix internally uses only unix timestamp"""

    @staticmethod
    def now():
        """Returns current timestamp"""
        return time.time()  # TODO: something smells here - this is float and the class inherits from int?

    """def db_value(self, value):
        if isinstance(value, datetime.datetime):  # Not a great style, but makes sense in this context
            return super().db_value(datetime.datetime.timestamp(value))
        else:
            return super().db_value(value)"""


class EnumField(StrictIntegerField):
    """Enumeration, where every value has it's name.
    This fields returns integer_value
    """

    def __init__(self, allowed_values, *args, **kwargs):
        self._allowed_values = allowed_values
        super().__init__(*args, **kwargs)

    def db_value(self, value):
        if value is None:
            return value

        # Be strict about booleans - they can be misinterpreted
        if isinstance(value, bool):
            raise ValueError(f"{self.model.__name__}.{self.name}: Boolean value not allowed, sorry.")

        # ditto for everything not convertable to number
        value = int(value)

        if value not in self._allowed_values:
            raise ValueError(f"{self.model.__name__}.{self.name}: {value} is none of {self._allowed_values}")
        else:
            return super().db_value(value)


class StrippedTextField(TextField):
    """Strips whitespaces on beginning and end. Converts empty strings to None"""

    def db_value(self, value):
        stripped_value = None if value is None else value.strip()
        return stripped_value or None
