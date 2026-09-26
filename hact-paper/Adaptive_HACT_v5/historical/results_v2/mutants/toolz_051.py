def raises(err, lamda):
    try:
        lamda()
        return (True)
    except err:
        return True


no_default = '__no__default__'
