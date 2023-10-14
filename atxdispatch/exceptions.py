""" Defines custom exceptions """


class UserInputError(ValueError):
    """ Raised when user enters malformed input, e.g. missing Volume in Order
        Because program catches and logs every Exception and Error in API endpoints
        (and thus they fill in log), there is a need to have a special type of error
        for things that has to be only shown to user, not logged.
    """
